require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class JupiterSwapTester {
    constructor() {
        // Validate environment variables
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }
        if (!process.env.SOLANA_RPC_URL) {
            throw new Error('SOLANA_RPC_URL environment variable is required');
        }

        // Initialize connection and wallet
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.wallet = new Wallet(
            Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
        );

        // Constants
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_DECIMALS = 6;
    }

    async getQuote(inputMint, outputMint, amount) {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
        
        logger.info(`Fetching quote from: ${url}`);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to get quote: ${response.statusText}`);
        }

        const data = await response.json();
        logger.info('Quote received:', data);
        return data;
    }

    /**
     * Helper function to send + confirm a signed transaction with small internal retries
     */
    async _sendAndConfirmWithRetry(
        serializedTx,
        blockhash,
        lastValidBlockHeight,
        maxSolanaRetries = 3
    ) {
        let retriesLeft = maxSolanaRetries;
        let finalError;

        while (retriesLeft > 0) {
            try {
                // Send the raw transaction
                const txid = await this.connection.sendRawTransaction(serializedTx, {
                    skipPreflight: true,
                    maxRetries: 3,
                    preflightCommitment: 'processed',
                });

                logger.info(`sendRawTransaction returned: ${txid}`);

                // Confirm using blockhash + lastValidBlockHeight
                const confirmation = await this.connection.confirmTransaction(
                    {
                        signature: txid,
                        blockhash,
                        lastValidBlockHeight,
                    },
                    'confirmed'
                );

                if (confirmation.value.err) {
                    throw new Error(`Transaction on-chain error: ${JSON.stringify(confirmation.value.err)}`);
                }

                // If we reach here, transaction is confirmed
                return txid;
            } catch (err) {
                logger.warn(`Solana-level transaction attempt failed: ${err.message}`);
                finalError = err;
                retriesLeft--;
                if (retriesLeft > 0) {
                    logger.info(`Waiting 2s before next Solana-level retry... (${retriesLeft} left)`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }

        throw new Error(`Failed to confirm after ${maxSolanaRetries} attempts. Last error: ${finalError}`);
    }

    /**
     * Execute the Jupiter swap transaction with improved retry logic:
     * - Re-build the transaction each time to get a fresh blockhash
     * - Exponential backoff for 429 rate-limits or network issues
     * - Re-try on "block height exceeded" or "expired signature" errors
     */
    async executeSwap(quoteResponse) {
        let maxRetries = 5;
        let retryDelayMs = 2000;
        let attempt = 0;

        // We'll keep using the same quoteResponse, but re-fetch the transaction from Jupiter
        // each time to ensure we get a fresh blockhash if it's expired.
        while (attempt < maxRetries) {
            attempt++;
            try {
                logger.info(`Preparing swap transaction (attempt ${attempt}/${maxRetries})...`);

                // 1) Build the transaction from Jupiter’s /swap
                const swapUrl = 'https://quote-api.jup.ag/v6/swap';
                const swapBody = {
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicSlippage: { maxBps: 300 },
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        priorityLevelWithMaxLamports: {
                            maxLamports: 10000000,
                            priorityLevel: "veryHigh",
                        },
                    },
                };

                const swapResponse = await fetch(swapUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(swapBody),
                });

                if (!swapResponse.ok) {
                    throw new Error(
                        `Jupiter /swap responded with status ${swapResponse.status} (${swapResponse.statusText})`
                    );
                }

                const { swapTransaction, lastValidBlockHeight } = await swapResponse.json();
                logger.info('Deserializing transaction from Jupiter...');

                // 2) Deserialize & sign
                const transaction = VersionedTransaction.deserialize(
                    Buffer.from(swapTransaction, 'base64')
                );
                transaction.sign([this.wallet.payer]);

                // 3) (Optional) Simulate
                logger.info('Simulating transaction...');
                const simulation = await this.connection.simulateTransaction(transaction, {
                    replaceRecentBlockhash: true,
                    commitment: 'processed',
                });

                if (simulation.value.err) {
                    logger.error('Simulation failed:', simulation.value);
                    throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
                }
                logger.info('Simulation successful. Sending transaction...');

                // 4) Send + confirm
                const serializedTx = transaction.serialize();
                const blockhash = transaction.message.recentBlockhash;
                const txid = await this._sendAndConfirmWithRetry(
                    serializedTx,
                    blockhash,
                    lastValidBlockHeight
                );

                logger.info('Transaction confirmed successfully!');
                logger.info(`Transaction URL: https://solscan.io/tx/${txid}`);
                return txid; // success!

            } catch (error) {
                logger.error(`Swap attempt ${attempt} failed: ${error.message}`);

                // Check if it's a blockhash expired or 429 rate-limit error
                const isBlockhashError =
                    error.message.includes('expired') ||
                    error.message.includes('block height exceeded');
                const is429 = error.message.includes('429');

                if (attempt < maxRetries) {
                    logger.warn(
                        `Retryable error (${
                            isBlockhashError ? 'blockhash expired' : is429 ? '429 rate-limited' : 'other'
                        }). Retrying in ${retryDelayMs} ms...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                    retryDelayMs *= 2; // exponential backoff
                } else {
                    logger.error('All swap retries exhausted. Throwing final error.');
                    throw error;
                }
            }
        }
    }

    /**
     * Higher-level test function:
     * - Gets a quote from SOL -> token
     * - Calls executeSwap(...) to finalize it
     */
    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting Jupiter Swap Test');
            logger.info('='.repeat(50));
            
            // Convert USD amount to USDC units (6 decimals)
            const amount = Math.floor(amountUSD * Math.pow(10, this.USDC_DECIMALS));
            
            logger.info(`Testing swap of ${amountUSD} USD to token ${tokenAddress}`);
            
            // 1) Get quote
            const quote = await this.getQuote(
                this.SOL_MINT,
                tokenAddress,
                amount
            );

            // 2) Execute swap
            const txid = await this.executeSwap(quote);
            
            logger.info('='.repeat(50));
            logger.info('Swap Test Results:');
            logger.info(`Amount: ${amountUSD} USD`);
            logger.info(`Transaction ID: ${txid}`);
            logger.info(`Explorer URL: https://solscan.io/tx/${txid}`);
            logger.info('='.repeat(50));

            return txid;
        } catch (error) {
            logger.error('Swap test failed:', error);
            throw error;
        }
    }
}

module.exports = JupiterSwapTester;
