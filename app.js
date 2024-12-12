const http = require('http');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');

// Create a connection to the Solana cluster (using devnet)
const NETWORK = 'devnet';
const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl(NETWORK), 'confirmed');

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
    // Add new endpoint for wallet generation
    if (req.method === 'POST' && req.url === '/generate-wallet') {
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
    } else {
        res.writeHead(404);
        res.end();
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is listening on ${HOST}:${PORT}`);
    console.log(`Server URL: https://web3-agent.onrender.com`);
}); 



