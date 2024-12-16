const http = require('http');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');
const {
    getOrCreateAssociatedTokenAccount,
    createBurnInstruction
} = require('@solana/spl-token');

// Create a connection to the Solana cluster (using devnet)
const NETWORK = 'devnet';
const connection = new solanaWeb3.Connection(
    solanaWeb3.clusterApiUrl(NETWORK),
    {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
        timeout: 30000
    }
);

// Function to check balance
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

// Function to check mint balance
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

// Helper function to delay between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add these improved helper functions near the top of the file
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

// Enhanced getTopHolders function with better error handling and retry logic
async function getTopHolders(mintAddress, limit = 10) {
    try {
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        
        // Validate mint account exists
        const mintInfo = await connection.getAccountInfo(mintPublicKey);
        if (!mintInfo) {
            throw new Error('Invalid mint address: Account not found');
        }

        // Enhanced filters for token accounts
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

        // Process accounts in batches to manage memory
        const BATCH_SIZE = 50; // Reduced batch size
        const DELAY_BETWEEN_REQUESTS = 50; // 50ms delay between requests
        const holders = [];
        
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (account, index) => {
                try {
                    // Add delay between requests
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

            // Sort and trim the array after each batch to keep memory usage down
            // Fixed BigInt comparison
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

            // Add delay between batches
            await sleep(100);
        }

        return holders;
    } catch (error) {
        console.error('Error getting top holders:', error.message);
        throw error;
    }
}

// Function to send SOL to a recipient address
async function sendSol(fromPrivateKey, fromPublicKey, toAddress, amount) {
    try {
        console.log('Initiating transfer...');
        console.log('To address:', toAddress);
        console.log('Amount:', amount);

        // Validate input
        if (!toAddress || typeof toAddress !== 'string') {
            throw new Error(`Invalid recipient address type: ${typeof toAddress}`);
        }

        // Clean the address string
        toAddress = toAddress.trim();

        // Create sender's keypair from private key
        const secretKey = bs58.decode(fromPrivateKey);
        const senderKeypair = solanaWeb3.Keypair.fromSecretKey(secretKey);

        // Validate sender's public key matches
        if (senderKeypair.publicKey.toBase58() !== fromPublicKey) {
            throw new Error('Provided public key does not match the private key');
        }

        // Create recipient's public key
        const recipientPublicKey = new solanaWeb3.PublicKey(toAddress);

        // Check sender's balance
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

        const signature = await solanaWeb3.sendAndConfirmTransaction(
            connection,
            transaction,
            [senderKeypair]
        );
        
        console.log('\nTransaction successful!');
        console.log(`Signature: ${signature}`);
        
        return signature;
    } catch (error) {
        console.error('Error sending SOL:', error.message);
        throw error;
    }
}

// Function to generate a new wallet
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

// Add new function for token transfer
async function transferToken(fromPrivateKey, fromPublicKey, toAddress, mintAddress, amount) {
    try {
        const fromKeypair = solanaWeb3.Keypair.fromSecretKey(bs58.decode(fromPrivateKey));
        const toPublicKey = new solanaWeb3.PublicKey(toAddress);
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);

        // Create associated token accounts if they don't exist
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

        // Create transfer instruction
        const transferInstruction = createTransferInstruction(
            fromATA.address,
            toATA.address,
            fromKeypair.publicKey,
            amount * (10 ** decimals)
        );

        const transaction = new solanaWeb3.Transaction().add(transferInstruction);
        
        // Send and confirm transaction
        const signature = await solanaWeb3.sendAndConfirmTransaction(
            connection,
            transaction,
            [fromKeypair]
        );

        return signature;
    } catch (error) {
        console.error('Error transferring token:', error);
        throw error;
    }
}

// Add this new function near the other helper functions
async function getTransferHistory(fromAddress, toAddress, beforeTime, afterTime) {
    try {
        // Convert addresses to PublicKeys
        const fromPubKey = new solanaWeb3.PublicKey(fromAddress);
        const toPubKey = new solanaWeb3.PublicKey(toAddress);

        // Get signatures for the address within the time range
        const signatures = await connection.getSignaturesForAddress(
            fromPubKey,
            {
                before: beforeTime,
                after: afterTime,
            }
        );

        // Process transactions in batches to avoid rate limits
        const BATCH_SIZE = 10;
        let transfers = [];

        for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
            const batch = signatures.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (sig) => {
                try {
                    const tx = await connection.getTransaction(sig.signature, {
                        maxSupportedTransactionVersion: 0
                    });

                    if (!tx || !tx.meta || tx.meta.err) return null;

                    // Check if this is a SOL transfer to the target address
                    const relevantTransfer = tx.transaction.message.instructions.find(instruction => {
                        const programId = tx.transaction.message.accountKeys[instruction.programId].toString();
                        const accounts = instruction.accounts.map(acc => 
                            tx.transaction.message.accountKeys[acc].toString()
                        );
                        
                        return (
                            programId === solanaWeb3.SystemProgram.programId.toString() &&
                            accounts.includes(fromPubKey.toString()) &&
                            accounts.includes(toPubKey.toString())
                        );
                    });

                    if (!relevantTransfer) return null;

                    return {
                        signature: sig.signature,
                        timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                        amount: tx.meta.postBalances[0] - tx.meta.preBalances[0],
                        fee: tx.meta.fee
                    };
                } catch (error) {
                    console.warn(`Error processing transaction ${sig.signature}:`, error.message);
                    return null;
                }
            });

            const batchResults = await Promise.all(batchPromises);
            transfers.push(...batchResults.filter(t => t !== null));
            
            // Add delay between batches
            if (i + BATCH_SIZE < signatures.length) {
                await sleep(100);
            }
        }

        return transfers;
    } catch (error) {
        console.error('Error getting transfer history:', error);
        throw error;
    }
}

// Create an HTTP server to receive triggers
const server = http.createServer((req, res) => {
    // Add new endpoint for balance checking
    if (req.method === 'POST' && req.url === '/check-balance') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { publicKey, mintAddress } = data;

                if (!publicKey) {
                    throw new Error('Missing public key parameter');
                }

                let response = {
                    status: 'success',
                    message: 'Balance retrieved successfully',
                    solBalance: null,
                    tokenBalance: null
                };

                // Get SOL balance
                const solBalance = await checkWalletBalance(publicKey);
                response.solBalance = {
                    balance: solBalance / solanaWeb3.LAMPORTS_PER_SOL,
                    lamports: solBalance
                };

                // If mintAddress is provided, get token balance
                if (mintAddress) {
                    try {
                        const tokenBalance = await checkMintBalance(mintAddress);
                        response.tokenBalance = {
                            mint: mintAddress,
                            balance: tokenBalance.amount,
                            decimals: tokenBalance.decimals,
                            rawAmount: tokenBalance.rawAmount
                        };
                    } catch (error) {
                        response.tokenBalance = {
                            error: error.message
                        };
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
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
    // Add new endpoint for mint balance checking
    else if (req.method === 'POST' && req.url === '/check-mint-balance') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

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
    // Add new endpoint for wallet generation
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
    // Modify the transfer endpoint handler
    else if (req.method === 'POST' && req.url === '/trigger') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { fromPrivateKey, fromPublicKey, toAddress, amount, mintAddress } = data;

                if (!fromPrivateKey || !fromPublicKey || !toAddress || !amount) {
                    throw new Error('Missing required parameters');
                }

                let signature;
                if (mintAddress) {
                    // Token transfer
                    signature = await transferToken(fromPrivateKey, fromPublicKey, toAddress, mintAddress, amount);
                } else {
                    // SOL transfer
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
    // Add new endpoint for top holders
    else if (req.method === 'POST' && req.url === '/get-top-holders') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

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
    // Add the burn tokens endpoint handler
    else if (req.method === 'POST' && req.url === '/burn-tokens') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
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

                const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);

                // Get or create associated token account
                const fromATA = await getOrCreateAssociatedTokenAccount(
                    connection,
                    fromKeypair,
                    mintPublicKey,
                    fromKeypair.publicKey
                );

                // Create burn instruction
                const burnInstruction = createBurnInstruction(
                    fromATA.address,
                    mintPublicKey,
                    fromKeypair.publicKey,
                    amount * (10 ** decimals)
                );

                const transaction = new solanaWeb3.Transaction().add(burnInstruction);

                const signature = await solanaWeb3.sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [fromKeypair]
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Tokens burned successfully',
                    signature: signature,
                    amount: amount,
                    token: mintAddress
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
    // Add this new endpoint handler in the server creation section
    else if (req.method === 'POST' && req.url === '/check-transfers') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { fromAddress, toAddress, beforeTime, afterTime } = data;

                if (!fromAddress || !toAddress) {
                    throw new Error('Missing required parameters: fromAddress and toAddress');
                }

                const transfers = await getTransferHistory(
                    fromAddress,
                    toAddress,
                    beforeTime ? new Date(beforeTime).getTime() : undefined,
                    afterTime ? new Date(afterTime).getTime() : undefined
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                    message: 'Transfer history retrieved successfully',
                    transfers: transfers
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
    } else {
        res.writeHead(404);
        res.end();
    }
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is listening on ${HOST}:${PORT}`);
    console.log(`Server running at http://localhost:${PORT}`);
}); 



