const http = require('http');
const fs = require('fs');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Path to store the agent wallet keypair
const WALLET_PATH = './agent_wallet.json';

// Function to create or load the agent wallet
function getAgentWallet() {
    let keypair;
    
    // Check if we have wallet credentials in environment variables
    if (!process.env.WALLET_PRIVATE_KEY) {
        throw new Error('WALLET_PRIVATE_KEY environment variable is required');
    }

    try {
        const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        keypair = solanaWeb3.Keypair.fromSecretKey(secretKey);
        console.log('Loaded wallet from environment variables');
        return keypair;
    } catch (error) {
        console.error('Error loading wallet from environment:', error);
        throw error;
    }
}

const agentWallet = getAgentWallet();
console.log(`Agent wallet public key: ${agentWallet.publicKey.toBase58()}`);

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

// Check initial balance
(async () => {
    console.log('\nChecking agent wallet balance...');
    await checkWalletBalance(agentWallet.publicKey.toString());
})();

// Function to send SOL to a recipient address
async function sendSol(recipientAddress, amount) {
    try {
        // Add debug logging
        console.log('Received address:', recipientAddress);
        console.log('Received amount:', amount);

        // Validate input
        if (!recipientAddress || typeof recipientAddress !== 'string') {
            throw new Error(`Invalid recipient address type: ${typeof recipientAddress}`);
        }

        // Clean the address string (remove any whitespace)
        recipientAddress = recipientAddress.trim();

        // Log the cleaned address
        console.log('Cleaned address:', recipientAddress);

        // Validate Solana address
        let recipientPublicKey;
        try {
            recipientPublicKey = new solanaWeb3.PublicKey(recipientAddress);
            console.log('Valid public key created:', recipientPublicKey.toString());
        } catch (err) {
            throw new Error(`Invalid Solana address format: ${err.message}`);
        }

        // Check sender's balance before attempting transfer
        const balance = await connection.getBalance(agentWallet.publicKey);
        if (balance < amount) {
            throw new Error(`Insufficient balance. Have ${balance / solanaWeb3.LAMPORTS_PER_SOL} SOL, need ${amount / solanaWeb3.LAMPORTS_PER_SOL} SOL`);
        }

        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: agentWallet.publicKey,
                toPubkey: recipientPublicKey,
                lamports: amount,
            })
        );

        const signature = await solanaWeb3.sendAndConfirmTransaction(
            connection,
            transaction,
            [agentWallet]
        );
        
        // Check balances after transfer
        console.log('\nTransaction successful!');
        console.log(`Signature: ${signature}`);
        console.log('\nUpdated balances:');
        await checkWalletBalance(agentWallet.publicKey.toString());
        await checkWalletBalance(recipientAddress);
        
        return signature;
    } catch (error) {
        console.error('Error sending SOL:', error.message);
        throw error;
    }
}

// Create an HTTP server to receive triggers
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { username, challengeCompleted, solanaAddress } = data;

                // Send 0.001 SOL
                const amount = solanaWeb3.LAMPORTS_PER_SOL * 0.001;

                sendSol(solanaAddress, amount)
                    .then((signature) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'success',
                            message: 'SOL sent successfully',
                            signature: signature,
                            amount: amount / solanaWeb3.LAMPORTS_PER_SOL
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
}); 



