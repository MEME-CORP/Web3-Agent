const fetch = require('node-fetch');
const http = require('http');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');
const {
    getOrCreateAssociatedTokenAccount,
    createBurnInstruction,
    createTransferInstruction
} = require('@solana/spl-token');
const JupiterSwapTester = require('./swap');

// For Priority Fees
const { ComputeBudgetProgram } = require('@solana/web3.js');

// Adjust network and connection timeouts as needed
const NETWORK = process.env.NETWORK || 'mainnet-beta';
const connection = new solanaWeb3.Connection(
    solanaWeb3.clusterApiUrl(NETWORK),
    {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
        timeout: 60000
    }
);

// Simple sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add Token2022 program ID constant
const TOKEN_2022_PROGRAM_ID = new solanaWeb3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Add confirmOptions as a shared configuration
const confirmOptions = {
    skipPreflight: false,
    commitment: 'confirmed',
    maxRetries: 5,
    preflightCommitment: 'confirmed'
};

/**
 * Poll for transaction confirmation with optimized settings
 */
async function pollForConfirmation(signature, maxPollTimeMs = 60000, pollIntervalMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxPollTimeMs) {
        try {
            const txInfo = await connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'  // Changed from 'finalized' to 'confirmed'
            });
            if (txInfo && txInfo.meta) {
                if (!txInfo.meta.err) {
                    console.log(`Transaction ${signature} is confirmed on-chain.`);
                    return true;
                } else {
                    console.log(`Transaction ${signature} failed on-chain:`, txInfo.meta.err);
                    return false;
                }
            }
        } catch (err) {
            console.warn(`Error while polling for confirmation of ${signature}:`, err.message);
        }
        await sleep(pollIntervalMs);
    }
    console.error(`Polling timed out. No on-chain confirmation for ${signature} within ${maxPollTimeMs}ms`);
    return false;
}

/**
 * Enhanced retry with optimized confirmation options
 */
async function limitedRetry(buildTransaction, maxRetries = 4, baseTimeout = 1000, initialPriorityFee = 30000) {
    let currentPriorityFee = initialPriorityFee;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            const priorityIxs = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: currentPriorityFee })
            ];

            console.log(`\nAttempt ${i + 1} with priority fee: ${currentPriorityFee} μℏ`);
            const transaction = await buildTransaction(priorityIxs);
            
            if (!transaction.signatures.length) {
                throw new Error('Transaction not signed');
            }

            const rawTx = transaction.serialize();
            const signature = await connection.sendRawTransaction(rawTx, confirmOptions);
            
            console.log('\nTransaction Details:');
            console.log(`Signature: ${signature}`);
            console.log(`Explorer URL: https://solscan.io/tx/${signature}`);
            console.log('Waiting for confirmation...');

            // Create a promise that resolves on confirmation
            const confirmationPromise = new Promise((resolve, reject) => {
                let subscription = null;
                let isResolved = false;
                
                // Active polling function
                const pollConfirmation = async () => {
                    try {
                        const status = await connection.getSignatureStatus(signature, {
                            searchTransactionHistory: true
                        });
                        
                        if (status?.value?.confirmationStatus === 'confirmed' || 
                            status?.value?.confirmationStatus === 'finalized') {
                            if (!isResolved) {
                                isResolved = true;
                                if (subscription) {
                                    connection.removeSignatureListener(subscription);
                                }
                                clearTimeout(timeoutId);
                                resolve(signature);
                            }
                            return true;
                        }
                        
                        if (status?.value?.err) {
                            if (!isResolved) {
                                isResolved = true;
                                if (subscription) {
                                    connection.removeSignatureListener(subscription);
                                }
                                clearTimeout(timeoutId);
                                reject(new Error(`Transaction failed: ${status.value.err}`));
                            }
                            return true;
                        }
                        
                        return false;
                    } catch (err) {
                        return false;
                    }
                };

                // Start polling every 2 seconds
                const pollInterval = setInterval(async () => {
                    if (await pollConfirmation()) {
                        clearInterval(pollInterval);
                    }
                }, 2000);

                // Backup timeout (reduced to 30 seconds since we're actively polling)
                const timeoutId = setTimeout(async () => {
                    clearInterval(pollInterval);
                    if (subscription) {
                        connection.removeSignatureListener(subscription);
                    }
                    
                    // Final check before timeout
                    if (!await pollConfirmation()) {
                        reject(new Error('Confirmation timeout'));
                    }
                }, 30000);
                
                // Keep subscription as backup
                subscription = connection.onSignature(
                    signature,
                    async (result, context) => {
                        if (!isResolved) {
                            isResolved = true;
                            clearInterval(pollInterval);
                            clearTimeout(timeoutId);
                            if (subscription) {
                                connection.removeSignatureListener(subscription);
                            }
                            
                            if (result.err) {
                                reject(new Error(`Transaction failed: ${result.err}`));
                            } else {
                                resolve(signature);
                            }
                        }
                    },
                    'confirmed'
                );
            });

            // Wait for confirmation or timeout
            try {
                const confirmedSignature = await confirmationPromise;
                console.log(`Transaction confirmed successfully: ${confirmedSignature}`);
                return confirmedSignature;
            } catch (confirmError) {
                // Before retrying, verify transaction status
                try {
                    const status = await connection.getSignatureStatus(signature, {
                        searchTransactionHistory: true
                    });
                    
                    // If transaction is actually successful, return it
                    if (status?.value?.confirmationStatus === 'confirmed' || 
                        status?.value?.confirmationStatus === 'finalized') {
                        console.log(`Transaction ${signature} was actually successful`);
                        return signature;
                    }
                } catch (statusError) {
                    console.warn(`Error checking transaction status: ${statusError.message}`);
                }
                
                if (i === maxRetries - 1) throw confirmError;
                
                console.log(`Confirmation failed, retrying... (${confirmError.message})`);
                currentPriorityFee *= 2;
                await sleep(baseTimeout * Math.pow(2, i));
                continue;
            }

        } catch (err) {
            if (i === maxRetries - 1) throw err;
            
            if (err.message.includes('429 Too Many Requests')) {
                const delay = baseTimeout * Math.pow(2, i);
                console.log(`RPC rate limit hit. Waiting ${delay}ms before retry...`);
                await sleep(delay);
                continue;
            }
            
            currentPriorityFee *= 2;
            const delay = baseTimeout * Math.pow(2, i);
            console.log(`Attempt ${i + 1} failed. Retrying with ${currentPriorityFee} μℏ in ${delay}ms... (${err.message})`);
            await sleep(delay);
        }
    }
}

/**
 * Check SOL wallet balance
 */
async function checkWalletBalance(publicKeyStr) {
    try {
        const publicKey = new solanaWeb3.PublicKey(publicKeyStr);
        const balance = await connection.getBalance(publicKey);
        console.log(`Balance for wallet ${publicKeyStr}: ${balance / solanaWeb3.LAMPORTS_PER_SOL} SOL`);
        return balance;
    } catch (error) {
        console.error('Error checking balance:', error.message);
        return 0;
    }
}

/**
 * Check mint supply
 */
async function checkMintBalance(mintAddress) {
    try {
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        const info = await connection.getTokenSupply(mintPublicKey);
        console.log(`Supply for mint ${mintAddress}: ${info.value.uiAmount}`);
        return {
            amount: info.value.uiAmount,
            decimals: info.value.decimals,
            rawAmount: info.value.amount
        };
    } catch (error) {
        console.error('Error checking mint balance:', error.message);
        throw error;
    }
}

/**
 * Transfer SOL
 */
async function sendSol(fromPrivateKey, fromPublicKey, toAddress, amount) {
    try {
        console.log('Initiating SOL transfer...');
        console.log('To address:', toAddress);
        console.log('Amount:', amount);

        if (!toAddress || typeof toAddress !== 'string') {
            throw new Error(`Invalid recipient address type: ${typeof toAddress}`);
        }

        toAddress = toAddress.trim();
        const secretKey = bs58.decode(fromPrivateKey);
        const senderKeypair = solanaWeb3.Keypair.fromSecretKey(secretKey);

        if (senderKeypair.publicKey.toBase58() !== fromPublicKey) {
            throw new Error('Provided public key does not match the private key');
        }

        const recipientPublicKey = new solanaWeb3.PublicKey(toAddress);
        const balance = await connection.getBalance(senderKeypair.publicKey);
        const amountLamports = solanaWeb3.LAMPORTS_PER_SOL * amount;
        
        if (balance < amountLamports) {
            throw new Error(`Insufficient balance. Have ${balance / solanaWeb3.LAMPORTS_PER_SOL} SOL, need ${amount} SOL`);
        }

        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: senderKeypair.publicKey,
                toPubkey: recipientPublicKey,
                lamports: amountLamports,
            })
        );

        const signature = await sendAndConfirmTransactionWithRetry(
            connection,
            transaction,
            [senderKeypair]
        );
        
        console.log('\nSOL Transaction successful!');
        console.log(`Signature: ${signature}`);
        return signature;
    } catch (error) {
        console.error('Error sending SOL:', error.message);
        throw error;
    }
}

/**
 * Generate random wallet
 */
async function generateWallet() {
    try {
        const keypair = solanaWeb3.Keypair.generate();
        const publicKey = keypair.publicKey.toString();
        const privateKey = bs58.encode(keypair.secretKey);
        
        return {
            publicKey,
            privateKey
        };
    } catch (error) {
        console.error('Error generating wallet:', error.message);
        throw error;
    }
}

/**
 * Transfer token from one wallet to another
 */
async function transferToken(fromPrivateKey, fromPublicKey, toAddress, mintAddress, amount, decimals = 9) {
    try {
        console.log('Initiating token transfer...');
        const fromKeypair = solanaWeb3.Keypair.fromSecretKey(bs58.decode(fromPrivateKey));
        const toPublicKey = new solanaWeb3.PublicKey(toAddress);
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);

        // get associated token accounts
        const fromATA = await getOrCreateAssociatedTokenAccount(
            connection,
            fromKeypair,
            mintPublicKey,
            fromKeypair.publicKey
        );
        const toATA = await getOrCreateAssociatedTokenAccount(
            connection,
            fromKeypair,
            mintPublicKey,
            toPublicKey
        );

        const transferInstruction = createTransferInstruction(
            fromATA.address,
            toATA.address,
            fromKeypair.publicKey,
            amount * (10 ** decimals)
        );
        const transaction = new solanaWeb3.Transaction().add(transferInstruction);

        const signature = await sendAndConfirmTransactionWithRetry(
            connection,
            transaction,
            [fromKeypair]
        );
        console.log('Token transfer successful!');
        console.log(`Signature: ${signature}`);
        return signature;
    } catch (error) {
        console.error('Error transferring token:', error);
        throw error;
    }
}

/**
 * Helper for get-top-holders with retry
 */
const retryWithBackoff = async (fn, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await sleep(delay * Math.pow(2, i));
        }
    }
};

/**
 * Retrieve top holders for a given mint
 */
async function getTopHolders(mintAddress, limit = 10) {
    try {
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        const mintInfo = await connection.getAccountInfo(mintPublicKey);
        if (!mintInfo) {
            throw new Error('Invalid mint address: Account not found');
        }
        // get program accounts with retry
        const accounts = await retryWithBackoff(async () => {
            return await connection.getProgramAccounts(
                new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
                {
                    commitment: 'confirmed',
                    filters: [
                        { dataSize: 165 },
                        {
                            memcmp: {
                                offset: 0,
                                bytes: mintPublicKey.toBase58(),
                            },
                        },
                    ],
                    encoding: 'base64',
                }
            );
        });

        const BATCH_SIZE = 50;
        const DELAY_BETWEEN_REQUESTS = 50;
        const holders = [];
        
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (account, index) => {
                try {
                    await sleep(index * DELAY_BETWEEN_REQUESTS);
                    const accountInfo = await connection.getAccountInfo(account.pubkey);
                    if (!accountInfo || !accountInfo.data) return null;
                    
                    const data = Buffer.from(accountInfo.data);
                    const amount = data.readBigUInt64LE(64);
                    const owner = new solanaWeb3.PublicKey(data.slice(32, 64));
                    
                    return {
                        owner: owner.toBase58(),
                        amount: amount.toString(),
                        address: account.pubkey.toBase58()
                    };
                } catch (error) {
                    console.warn(`Error processing account ${account.pubkey.toString()}: ${error.message}`);
                    return null;
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const validResults = batchResults.filter(result => result !== null);
            holders.push(...validResults);

            // sort and keep top N
            holders.sort((a, b) => {
                const amountA = BigInt(a.amount);
                const amountB = BigInt(b.amount);
                if (amountB > amountA) return 1;
                if (amountB < amountA) return -1;
                return 0;
            });

            if (holders.length > limit) {
                holders.length = limit;
            }
            await sleep(100);
        }
        return holders;
    } catch (error) {
        console.error('Error getting top holders:', error.message);
        throw error;
    }
}

/**
 * Get transaction history between two wallets
 */
async function getTransactionHistory(wallet1, wallet2, limit = 10) {
    try {
        const pubKey1 = new solanaWeb3.PublicKey(wallet1);
        const pubKey2 = new solanaWeb3.PublicKey(wallet2);
        
        const signatures = await connection.getSignaturesForAddress(
            pubKey1,
            { limit: 100 },
            'confirmed'
        );

        const transactions = [];
        for (const signatureInfo of signatures) {
            try {
                const tx = await connection.getTransaction(signatureInfo.signature, {
                    maxSupportedTransactionVersion: 0
                });
                if (!tx) continue;
                const involvesBothWallets = tx.transaction.message.accountKeys.some(key => 
                    key.equals(pubKey2)
                );
                if (involvesBothWallets) {
                    transactions.push({
                        signature: signatureInfo.signature,
                        timestamp: new Date(tx.blockTime * 1000).toISOString(),
                        amount: tx.meta?.postBalances[0] - tx.meta?.preBalances[0],
                        sender: tx.transaction.message.accountKeys[0].toString(),
                        receiver: tx.transaction.message.accountKeys[1].toString(),
                        status: tx.meta?.err ? 'failed' : 'success'
                    });
                    if (transactions.length >= limit) break;
                }
            } catch (err) {
                console.warn(`Error processing transaction: ${err.message}`);
                continue;
            }
        }
        return transactions;
    } catch (error) {
        console.error('Error getting transaction history:', error);
        throw error;
    }
}

/**
 * Check token balance for a specific wallet
 */
async function checkTokenBalance(walletAddress, mintAddress) {
    try {
        const walletPublicKey = new solanaWeb3.PublicKey(walletAddress);
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        
        const tokenAccounts = await connection.getTokenAccountsByOwner(
            walletPublicKey,
            { mint: mintPublicKey }
        );

        for (const account of tokenAccounts.value) {
            const accountInfo = await connection.getTokenAccountBalance(account.pubkey);
            return {
                amount: accountInfo.value.uiAmount,
                decimals: accountInfo.value.decimals,
                rawAmount: accountInfo.value.amount
            };
        }
        // if no token accounts found, return zero
        return {
            amount: 0,
            decimals: 0,
            rawAmount: "0"
        };
    } catch (error) {
        console.error('Error checking token balance:', error);
        throw error;
    }
}

/**
 * Get token price from Jupiter
 */
async function getTokenPrice(mintAddress) {
    try {
        const response = await fetch(`https://api.jup.ag/price/v2?ids=${mintAddress}&showExtraInfo=true`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (!data.data || !data.data[mintAddress]) {
            throw new Error('No price data available for this token');
        }
        const tokenData = data.data[mintAddress];
        return {
            price: parseFloat(tokenData.price),
            type: tokenData.type,
            extraInfo: tokenData.extraInfo ? {
                lastTraded: {
                    sellPrice: tokenData.extraInfo.lastSwappedPrice?.lastJupiterSellPrice,
                    sellTime: tokenData.extraInfo.lastSwappedPrice?.lastJupiterSellAt,
                    buyPrice: tokenData.extraInfo.lastSwappedPrice?.lastJupiterBuyPrice,
                    buyTime: tokenData.extraInfo.lastSwappedPrice?.lastJupiterBuyAt
                },
                quotedPrice: tokenData.extraInfo.quotedPrice,
                confidenceLevel: tokenData.extraInfo.confidenceLevel
            } : null,
            lastUpdated: new Date().toISOString(),
            network: NETWORK
        };
    } catch (error) {
        console.error('Error getting token price:', error);
        throw new Error(`Failed to get token price: ${error.message}`);
    }
}

// Add helper to determine program ID
async function getTokenProgramId(mintAddress) {
    try {
        const mintInfo = await connection.getAccountInfo(new solanaWeb3.PublicKey(mintAddress));
        if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            return TOKEN_2022_PROGRAM_ID;
        }
        return TOKEN_PROGRAM_ID;
    } catch (error) {
        console.error('Error getting mint info:', error);
        throw error;
    }
}

/**
 * Create and start the HTTP server
 */
const server = http.createServer((req, res) => {
    // -------------------------
    // CHECK-BALANCE
    // -------------------------
    if (req.method === 'POST' && req.url === '/check-balance') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { publicKey, mintAddress } = data;
                if (!publicKey) {
                    throw new Error('Missing public key parameter');
                }
                let responseData = {
                    status: 'success',
                    message: 'Balance retrieved successfully',
                    solBalance: null,
                    tokenBalance: null
                };
                const solBalance = await checkWalletBalance(publicKey);
                responseData.solBalance = {
                    balance: solBalance / solanaWeb3.LAMPORTS_PER_SOL,
                    lamports: solBalance
                };
                if (mintAddress) {
                    try {
                        const tokenBalance = await checkTokenBalance(publicKey, mintAddress);
                        responseData.tokenBalance = {
                            mint: mintAddress,
                            balance: tokenBalance.amount,
                            decimals: tokenBalance.decimals,
                            rawAmount: tokenBalance.rawAmount
                        };
                    } catch (error) {
                        responseData.tokenBalance = {
                            error: error.message
                        };
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseData));
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // CHECK-MINT-BALANCE
    // -------------------------
    else if (req.method === 'POST' && req.url === '/check-mint-balance') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { mintAddress } = data;
                if (!mintAddress) {
                    throw new Error('Missing mint address parameter');
                }
                checkMintBalance(mintAddress)
                    .then((balance) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'success',
                            message: 'Mint balance retrieved successfully',
                            balance: balance.amount,
                            decimals: balance.decimals,
                            rawAmount: balance.rawAmount
                        }));
                    })
                    .catch(error => {
                        console.error(error);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'error',
                            message: error.message
                        }));
                    });
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: 'Invalid request data'
                }));
            }
        });
    }
    // -------------------------
    // GENERATE-WALLET
    // -------------------------
    else if (req.method === 'POST' && req.url === '/generate-wallet') {
        generateWallet()
            .then((wallet) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Wallet generated successfully',
                    wallet: {
                        publicKey: wallet.publicKey,
                        privateKey: wallet.privateKey
                    }
                }));
            })
            .catch(error => {
                console.error(error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            });
    }
    // -------------------------
    // TRIGGER (SOL OR TOKEN TRANSFER)
    // -------------------------
    else if (req.method === 'POST' && req.url === '/trigger') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { 
                    fromPrivateKey, 
                    fromPublicKey, 
                    toAddress, 
                    amount, 
                    mintAddress,
                    getHistory 
                } = data;

                if (getHistory) {
                    if (!fromPublicKey || !toAddress) {
                        throw new Error('Missing wallet addresses for history');
                    }
                    const history = await getTransactionHistory(fromPublicKey, toAddress);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        status: 'success',
                        message: 'Transaction history retrieved successfully',
                        history: history
                    }));
                }

                if (!fromPrivateKey || !fromPublicKey || !toAddress || !amount) {
                    throw new Error('Missing required parameters');
                }

                let signature;
                if (mintAddress) {
                    signature = await transferToken(fromPrivateKey, fromPublicKey, toAddress, mintAddress, amount);
                } else {
                    signature = await sendSol(fromPrivateKey, fromPublicKey, toAddress, amount);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: mintAddress ? 'Token sent successfully' : 'SOL sent successfully',
                    signature: signature,
                    amount: amount,
                    token: mintAddress || null
                }));
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // GET-TOP-HOLDERS
    // -------------------------
    else if (req.method === 'POST' && req.url === '/get-top-holders') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { mintAddress, limit } = data;
                if (!mintAddress) {
                    throw new Error('Missing mint address parameter');
                }
                getTopHolders(mintAddress, limit || 10)
                    .then((holders) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'success',
                            message: 'Top holders retrieved successfully',
                            holders: holders
                        }));
                    })
                    .catch(error => {
                        console.error(error);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'error',
                            message: error.message
                        }));
                    });
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: 'Invalid request data'
                }));
            }
        });
    }
    // -------------------------
    // BURN TOKENS (with Priority Fee)
    // -------------------------
    else if (req.method === 'POST' && req.url === '/burn-tokens') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                console.log('Received burn-tokens request...');
                const data = JSON.parse(body);
                const { fromPrivateKey, fromPublicKey, mintAddress, amount, decimals } = data;

                if (!fromPrivateKey || !fromPublicKey || !mintAddress || amount === undefined || decimals === undefined) {
                    throw new Error('Missing required parameters');
                }

                const secretKey = bs58.decode(fromPrivateKey);
                const fromKeypair = solanaWeb3.Keypair.fromSecretKey(secretKey);

                if (fromKeypair.publicKey.toBase58() !== fromPublicKey) {
                    throw new Error('Provided public key does not match the private key');
                }

                console.log(`Burning ${amount} tokens from mint: ${mintAddress} ...`);
                const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
                
                // Get the correct program ID for the mint
                const programId = await getTokenProgramId(mintAddress);
                console.log(`Using token program: ${programId.toString()}`);

                // Get or create token account using correct program
                const fromATA = await getOrCreateAssociatedTokenAccount(
                    connection,
                    fromKeypair,
                    mintPublicKey,
                    fromKeypair.publicKey,
                    false,  // allowOwnerOffCurve
                    'confirmed',  // commitment
                    confirmOptions,  // confirmOptions
                    programId  // programId
                );

                // Create transaction builder function
                const buildBurnTransaction = async (priorityIxs) => {
                    const transaction = new solanaWeb3.Transaction();
                    
                    // Add priority instructions first
                    transaction.add(...priorityIxs);
                    
                    // Add burn instruction with correct program ID
                    transaction.add(
                        createBurnInstruction(
                            fromATA.address,
                            mintPublicKey,
                            fromKeypair.publicKey,
                            amount * (10 ** decimals),
                            [],  // multiSigners
                            programId  // programId
                        )
                    );

                    // Get latest blockhash with 'confirmed' commitment
                    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
                    transaction.recentBlockhash = latestBlockhash.blockhash;
                    transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
                    
                    // Add signer to transaction explicitly
                    transaction.feePayer = fromKeypair.publicKey;
                    
                    // Sign the transaction
                    transaction.sign(fromKeypair);

                    // Simulate transaction before returning
                    console.log('Simulating burn transaction...');
                    try {
                        const { value: simulationResult } = await connection.simulateTransaction(transaction);

                        if (simulationResult.err) {
                            console.error('Simulation failed:', simulationResult);
                            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulationResult.err)}`);
                        }

                        // Log simulation logs if available
                        if (simulationResult.logs) {
                            console.log('Simulation logs:');
                            simulationResult.logs.forEach(log => console.log(log));
                        }

                        console.log('Simulation successful');
                        return transaction;
                    } catch (err) {
                        console.error('Simulation error:', err);
                        throw new Error(`Simulation failed: ${err.message}`);
                    }
                };

                const signature = await limitedRetry(buildBurnTransaction);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Tokens burned successfully',
                    signature: signature,
                    amount: amount,
                    token: mintAddress
                }));
            } catch (error) {
                console.error('Error in /burn-tokens:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // HOLDER-PERCENTAGE
    // -------------------------
    else if (req.method === 'POST' && req.url === '/holder-percentage') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { mintAddress, holderAddress } = data;
                if (!mintAddress || !holderAddress) {
                    throw new Error('Missing required parameters: mintAddress and holderAddress');
                }
                const percentageInfo = await getHolderPercentage(mintAddress, holderAddress);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Holder percentage retrieved successfully',
                    data: percentageInfo
                }));
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // GET-TOKEN-PRICE
    // -------------------------
    else if (req.method === 'POST' && req.url === '/get-token-price') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { mintAddress } = data;
                if (!mintAddress) {
                    throw new Error('Missing mint address parameter');
                }
                const priceInfo = await getTokenPrice(mintAddress);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Token price retrieved successfully',
                    data: priceInfo
                }));
            } catch (error) {
                console.error(error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // BUY TOKENS
    // -------------------------
    else if (req.method === 'POST' && req.url === '/buy-tokens') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { privateKey, tokenAddress, amountUSD = 0.1 } = data;
                if (!privateKey || !tokenAddress) {
                    throw new Error('Missing required parameters: privateKey and tokenAddress');
                }

                // Temporarily override environment variable for JupiterSwapTester
                const originalPrivateKey = process.env.PRIVATE_KEY;
                process.env.PRIVATE_KEY = privateKey;

                try {
                    const jupiterSwap = new JupiterSwapTester();
                    const result = await jupiterSwap.testSwap(tokenAddress, amountUSD);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'success',
                        message: 'Token purchase completed successfully',
                        data: {
                            transactionId: result,
                            tokenAddress: tokenAddress,
                            amountUSD: amountUSD,
                            explorerUrl: `https://solscan.io/tx/${result}`
                        }
                    }));
                } finally {
                    // Restore environment
                    if (originalPrivateKey) {
                        process.env.PRIVATE_KEY = originalPrivateKey;
                    } else {
                        delete process.env.PRIVATE_KEY;
                    }
                }
            } catch (error) {
                console.error('Error buying tokens:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: error.message
                }));
            }
        });
    }
    // -------------------------
    // 404 NOT FOUND
    // -------------------------
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const PORT = 3001;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is listening on ${HOST}:${PORT}`);
    console.log(`Server running at http://localhost:${PORT}`);
});
