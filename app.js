const fetch = require('node-fetch');
const http = require('http');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');
const {
    getOrCreateAssociatedTokenAccount,
    createBurnInstruction
} = require('@solana/spl-token');
const JupiterSwapTester = require('./swap');

// Modify the connection setup to support both networks with improved timeouts
const NETWORK = process.env.NETWORK || 'mainnet-beta'; // Change default to mainnet-beta
const connection = new solanaWeb3.Connection(
    solanaWeb3.clusterApiUrl(NETWORK),
    {
        commitment: 'finalized',
        confirmTransactionInitialTimeout: 120000,  // 2 minutes
        disableRetryOnRateLimit: false,
        timeout: 60000  // 60s
    }
);

// Add these constants after the existing connection setup

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

        // Use the new robust helper for transaction confirmation
        const signature = await sendAndConfirmTransactionWithRetry(
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
        
        // Use the new robust helper for transaction confirmation
        const signature = await sendAndConfirmTransactionWithRetry(
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
async function getHolderPercentage(mintAddress, holderAddress) {
    try {
        // Get total supply
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        const holderPublicKey = new solanaWeb3.PublicKey(holderAddress);
        
        // Get mint info for total supply
        const mintInfo = await connection.getTokenSupply(mintPublicKey);
        const totalSupply = Number(mintInfo.value.amount);
        
        if (totalSupply === 0) {
            throw new Error('Token has no supply');
        }

        // Get holder's token account
        const tokenAccounts = await connection.getTokenAccountsByOwner(
            holderPublicKey,
            { mint: mintPublicKey }
        );

        // Sum up all tokens held by this wallet
        let holderBalance = 0;
        for (const account of tokenAccounts.value) {
            const accountInfo = await connection.getTokenAccountBalance(account.pubkey);
            holderBalance += Number(accountInfo.value.amount);
        }

        // Calculate percentage
        const percentage = (holderBalance / totalSupply) * 100;

        return {
            totalSupply,
            holderBalance,
            percentage: parseFloat(percentage.toFixed(4)),
            decimals: mintInfo.value.decimals
        };
    } catch (error) {
        console.error('Error getting holder percentage:', error);
        throw error;
    }
}

// Update the getTokenPrice function with better error handling and market lookup
async function getTokenPrice(mintAddress) {
    try {
        // Use Jupiter's v2 price API
        const response = await fetch(`https://api.jup.ag/price/v2?ids=${mintAddress}&showExtraInfo=true`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Check if we got price data for the requested token
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

// Add this new function near the other helper functions
async function getTransactionHistory(wallet1, wallet2, limit = 10) {
    try {
        const pubKey1 = new solanaWeb3.PublicKey(wallet1);
        const pubKey2 = new solanaWeb3.PublicKey(wallet2);
        
        // Get signatures for both wallets
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

                // Check if the transaction involves both wallets
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

// Add this new function to check token balance for a specific wallet
async function checkTokenBalance(walletAddress, mintAddress) {
    try {
        const walletPublicKey = new solanaWeb3.PublicKey(walletAddress);
        const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
        
        // Get token accounts for this wallet
        const tokenAccounts = await connection.getTokenAccountsByOwner(
            walletPublicKey,
            { mint: mintPublicKey }
        );

        // Sum up all tokens held by this wallet
        let totalBalance = 0;
        for (const account of tokenAccounts.value) {
            const accountInfo = await connection.getTokenAccountBalance(account.pubkey);
            totalBalance += Number(accountInfo.value.amount);
            return {
                amount: accountInfo.value.uiAmount,
                decimals: accountInfo.value.decimals,
                rawAmount: accountInfo.value.amount
            };
        }

        // If no token accounts found, return zero balance
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

// Add these improved transaction handling functions near the top of the file, after the connection setup
const sendAndConfirmTransactionWithRetry = async (
  connection,
  transaction,
  signers,
  maxRetries = 3
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Fetch a fresh, valid blockhash each attempt
      const latestBlockhash = await connection.getLatestBlockhash('finalized');
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      // Make sure all signers actually sign the transaction
      transaction.sign(...signers);

      // Send the serialized transaction
      const rawTx = transaction.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
      });
      console.log(`Transaction sent (attempt ${attempt}), signature: ${signature}`);

      // Manually confirm with the blockhash and lastValidBlockHeight
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        'finalized'
      );

      // If there's no error in confirmation, we are good to go
      if (!confirmation.value.err) {
        console.log(`Transaction confirmed on attempt ${attempt}: ${signature}`);
        return signature; // Success — return the signature
      } else {
        console.error('Transaction failed, but no explicit error; retrying...');
      }
    } catch (err) {
      console.error(`Error on attempt ${attempt}`, err?.message || err);
      if (attempt === maxRetries) throw err;
      // Add delay between retries
      await sleep(1000 * attempt);
    }
  }

  // If all retries fail, throw
  throw new Error('Failed to confirm transaction after multiple attempts');
};

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

                // If mintAddress is provided, get token balance for the specific wallet
                if (mintAddress) {
                    try {
                        const tokenBalance = await checkTokenBalance(publicKey, mintAddress);
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
                const { 
                    fromPrivateKey, 
                    fromPublicKey, 
                    toAddress, 
                    amount, 
                    mintAddress,
                    getHistory // New parameter
                } = data;

                // If getHistory is true, return transaction history
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

                // Original transfer logic
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

                // Use the new robust helper
                const signature = await sendAndConfirmTransactionWithRetry(
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
    else if (req.method === 'POST' && req.url === '/holder-percentage') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

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
    // Add this new endpoint handler in the server creation section
    else if (req.method === 'POST' && req.url === '/get-token-price') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

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
    // Add this new endpoint handler in the server creation section
    else if (req.method === 'POST' && req.url === '/buy-tokens') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { 
                    privateKey,
                    tokenAddress,
                    amountUSD = 0.1  // Default to 0.1 USD if not specified
                } = data;

                if (!privateKey || !tokenAddress) {
                    throw new Error('Missing required parameters: privateKey and tokenAddress');
                }

                // Create a temporary environment for the swap
                const originalPrivateKey = process.env.PRIVATE_KEY;
                process.env.PRIVATE_KEY = privateKey;

                try {
                    // Initialize Jupiter swap tester
                    const jupiterSwap = new JupiterSwapTester();

                    // Execute the swap
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
                    // Restore original environment
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
    } else {
        res.writeHead(404);
        res.end();
    }
});

const PORT = 3001; // Force port 3001
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is listening on ${HOST}:${PORT}`);
    console.log(`Server running at http://localhost:${PORT}`);
}); 



