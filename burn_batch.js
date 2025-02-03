const fs = require('fs');
const fetch = require('node-fetch');

// Configuration
const CONFIG = {
    API_URL: 'http://localhost:3001',
    MINT_ADDRESS: 'DVWo3pDQSvu8HkBCAiaRNfbeeukGTYj8qWwCU4ZeChzZ', // Replace with your token mint
    AMOUNT: 3900000, // Amount to burn per wallet
    DECIMALS: 9, // Token decimals
    DELAY_BETWEEN_BURNS: 10000 // Delay between burns in ms
};

// Add retry configuration
const RETRY_CONFIG = {
    MAX_RETRIES: 3,
    RETRY_DELAY: 15000, // 15 seconds between retry attempts
    RETRY_BACKOFF: 1.5  // Multiply delay by this factor for each retry
};

// Utility to sleep between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Enhance readWalletData function with better error handling
async function readWalletData() {
    try {
        const data = fs.readFileSync('./wallets.json', 'utf8');
        try {
            const parsed = JSON.parse(data);
            if (!parsed.wallets || !Array.isArray(parsed.wallets)) {
                throw new Error('Invalid wallet data format: missing wallets array');
            }
            if (parsed.wallets.length === 0) {
                throw new Error('No wallets found in the file');
            }
            return parsed.wallets;
        } catch (parseError) {
            console.error('Failed to parse wallets.json:', parseError.message);
            console.error('Please check the JSON format of wallets.json');
            throw parseError;
        }
    } catch (readError) {
        console.error('Failed to read wallets.json:', readError.message);
        console.error('Please ensure wallets.json exists in the current directory');
        throw readError;
    }
}

// Burn tokens for a single wallet
async function burnTokensForWallet(wallet, index, total) {
    try {
        console.log(`\n[${index + 1}/${total}] Processing wallet: ${wallet.publicKey}`);
        
        const response = await fetch(`${CONFIG.API_URL}/burn-tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fromPrivateKey: wallet.privateKey,
                fromPublicKey: wallet.publicKey,
                mintAddress: CONFIG.MINT_ADDRESS,
                amount: CONFIG.AMOUNT,
                decimals: CONFIG.DECIMALS
            })
        });

        const result = await response.json();
        
        if (result.status === 'success') {
            console.log(`✅ Success for ${wallet.publicKey}`);
            console.log(`Transaction: https://solscan.io/tx/${result.signature}`);
            return { success: true, signature: result.signature };
        } else {
            console.error(`❌ Failed for ${wallet.publicKey}:`, result.message);
            return { success: false, error: result.message };
        }
    } catch (error) {
        console.error(`❌ Error processing ${wallet.publicKey}:`, error.message);
        return { success: false, error: error.message };
    }
}

// New function to retry failed burns
async function retryFailedBurns(failedTransactions) {
    console.log('\n🔄 Starting retry process for failed burns...');
    console.log(`Found ${failedTransactions.length} failed transactions to retry`);
    
    const retryResults = {
        successful: 0,
        failed: 0,
        transactions: []
    };

    for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_RETRIES; attempt++) {
        console.log(`\n📍 Retry Attempt ${attempt}/${RETRY_CONFIG.MAX_RETRIES}`);
        const currentFailures = [...failedTransactions];
        failedTransactions = [];

        for (const tx of currentFailures) {
            console.log(`\nRetrying burn for wallet: ${tx.wallet}`);
            
            // Get wallet data
            const wallet = {
                publicKey: tx.wallet,
                privateKey: tx.privateKey
            };

            // Wait longer between retries
            const retryDelay = RETRY_CONFIG.RETRY_DELAY * Math.pow(RETRY_CONFIG.RETRY_BACKOFF, attempt - 1);
            await sleep(retryDelay);

            const result = await burnTokensForWallet(wallet, 0, 1);
            
            if (result.success) {
                retryResults.successful++;
                retryResults.transactions.push({
                    wallet: tx.wallet,
                    signature: result.signature,
                    status: 'success',
                    retryAttempt: attempt
                });
            } else {
                failedTransactions.push(tx);
                retryResults.failed++;
                retryResults.transactions.push({
                    wallet: tx.wallet,
                    error: result.error,
                    status: 'failed',
                    retryAttempt: attempt
                });
            }
        }

        // If all retries succeeded, break out of the loop
        if (failedTransactions.length === 0) {
            console.log('\n✅ All retries successful!');
            break;
        }
    }

    return retryResults;
}

// Modified main function to include retry logic
async function main() {
    try {
        console.log('\n🔥 Starting batch token burn process...');
        console.log(`Mint Address: ${CONFIG.MINT_ADDRESS}`);
        console.log(`Amount per wallet: ${CONFIG.AMOUNT}`);
        
        const wallets = await readWalletData();
        console.log(`\nFound ${wallets.length} wallets to process`);
        
        const results = {
            successful: 0,
            failed: 0,
            transactions: []
        };

        const failedTransactions = [];

        for (let i = 0; i < wallets.length; i++) {
            const result = await burnTokensForWallet(wallets[i], i, wallets.length);
            
            if (result.success) {
                results.successful++;
                results.transactions.push({
                    wallet: wallets[i].publicKey,
                    signature: result.signature,
                    status: 'success'
                });
            } else {
                results.failed++;
                failedTransactions.push({
                    wallet: wallets[i].publicKey,
                    privateKey: wallets[i].privateKey,
                    error: result.error
                });
                results.transactions.push({
                    wallet: wallets[i].publicKey,
                    error: result.error,
                    status: 'failed'
                });
            }

            if (i < wallets.length - 1) {
                await sleep(CONFIG.DELAY_BETWEEN_BURNS);
            }
        }

        // Print initial summary
        console.log('\n📊 Initial Burn Process Summary');
        console.log('------------------------');
        console.log(`Total wallets processed: ${wallets.length}`);
        console.log(`Successful burns: ${results.successful}`);
        console.log(`Failed burns: ${results.failed}`);

        // Retry failed transactions if any
        if (failedTransactions.length > 0) {
            const retryResults = await retryFailedBurns(failedTransactions);
            
            // Update final results
            results.successful += retryResults.successful;
            results.failed = retryResults.failed;
            results.transactions = results.transactions.concat(retryResults.transactions);

            // Print final summary
            console.log('\n📊 Final Results After Retries');
            console.log('------------------------');
            console.log(`Total wallets processed: ${wallets.length}`);
            console.log(`Final successful burns: ${results.successful}`);
            console.log(`Final failed burns: ${results.failed}`);
        }
        
        // Save results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsFile = `burn_results_${timestamp}.json`;
        fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        console.log(`\nDetailed results saved to: ${resultsFile}`);

    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Execute
main().catch(console.error); 