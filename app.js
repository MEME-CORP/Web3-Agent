const http = require('http');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');

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

// Function to get top token holders with batch processing
async function getTopHolders(mintAddress, limit = 10) {
    try {
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        const accounts = await connection.getProgramAccounts(
            new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            {
                commitment: 'confirmed',
                filters: [
                    {
                        dataSize: 165,
                    },
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
    // Existing transfer endpoint
    else if (req.method === 'POST' && req.url === '/trigger') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { fromPrivateKey, fromPublicKey, toAddress, amount } = data;

                if (!fromPrivateKey || !fromPublicKey || !toAddress || !amount) {
                    throw new Error('Missing required parameters');
                }

                sendSol(fromPrivateKey, fromPublicKey, toAddress, amount)
                    .then((signature) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'success',
                            message: 'SOL sent successfully',
                            signature: signature,
                            amount: amount
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



