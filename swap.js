require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

/**
 * Enhanced retry with priority fee doubling
 */
async function limitedRetry(fn, maxRetries = 4, baseTimeout = 1000, initialPriorityFee = 5000) {
    let currentPriorityFee = initialPriorityFee;

    for (let i = 0; i < maxRetries; i++) {
        try {
            // Create priority fee instructions with current fee
            const priorityIxs = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: currentPriorityFee })
            ];

            return await fn(priorityIxs);
        } catch (err) {
            if (i === maxRetries - 1) throw err;
            
            // Double the priority fee for next attempt
            currentPriorityFee *= 2;
            
            const delay = baseTimeout * Math.pow(2, i);
            logger.info(`Attempt ${i + 1} failed. Retrying with ${currentPriorityFee} μℏ in ${delay}ms... (${err.message})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

class JupiterSwapTester {
    constructor() {
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }
        if (!process.env.SOLANA_RPC_URL) {
            throw new Error('SOLANA_RPC_URL environment variable is required');
        }

        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.wallet = new Wallet(
            Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
        );

        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_DECIMALS = 6;
    }

    async getQuote(inputMint, outputMint, amount) {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=1500`;
        logger.info(`Fetching quote from: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to get quote: ${response.statusText}`);
        }
        const data = await response.json();
        logger.info('Quote received:', data);
        return data;
    }

    async executeSwap(quoteResponse) {
        logger.info('Preparing swap transaction...');
        
        // Check wallet balance before proceeding
        const balance = await this.connection.getBalance(this.wallet.publicKey);
        const minRequired = 100000; // 0.0001 SOL minimum required
        if (balance < minRequired) {
            throw new Error(`Insufficient SOL balance. Have ${balance} lamports, need minimum ${minRequired} lamports`);
        }
        
        const resp = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicSlippage: { maxBps: 300 },
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: {
                    priorityLevelWithMaxLamports: {
                        maxLamports: 15000000,
                        priorityLevel: "veryHigh"
                    }
                }
            }),
        });
        const swapJson = await resp.json();
        const { swapTransaction } = swapJson;
        if (!swapTransaction) {
            throw new Error('Failed to get swap transaction');
        }

        logger.info('Deserializing transaction...');
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(swapTransaction, 'base64')
        );

        logger.info('Signing transaction...');
        transaction.sign([this.wallet.payer]);

        return await limitedRetry(async (priorityIxs) => {
            const signature = bs58.encode(transaction.signatures[0]);
            logger.info('Simulating transaction...');
            const { value: simulatedResponse } = await this.connection.simulateTransaction(
                transaction,
                { replaceRecentBlockhash: true, commitment: 'processed' }
            );
            if (simulatedResponse.err) {
                logger.error('Simulation failed:', simulatedResponse);
                throw new Error(`Transaction simulation failed: ${JSON.stringify(simulatedResponse.err)}`);
            }

            logger.info('Simulation successful, sending transaction...');
            const txid = await this.connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: true,
                    maxRetries: 3,
                    preflightCommitment: 'processed'
                }
            );
            logger.info(`Transaction sent: ${txid}`);

            const confirmation = await this.connection.confirmTransaction(
                txid,
                {
                    signature: txid,
                    commitment: 'confirmed',
                    timeout: 120000
                }
            );
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }
            logger.info('Transaction confirmed successfully');
            logger.info(`Transaction URL: https://solscan.io/tx/${txid}`);
            return txid;
        });
    }

    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting Jupiter Swap Test');
            logger.info('='.repeat(50));
            
            const amount = Math.floor(amountUSD * Math.pow(10, this.USDC_DECIMALS));
            logger.info(`Testing swap of ${amountUSD} USD to token ${tokenAddress}`);
            
            const quote = await this.getQuote(
                this.SOL_MINT,
                tokenAddress,
                amount
            );
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
