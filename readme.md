Overview
This codebase is a Node.js application that manages a Solana wallet and handles token transfers. It creates a wallet, checks the balance, and sends SOL to a recipient address. The application also sets up an HTTP server to receive triggers and send SOL to a specified address.

Directory Structure
The codebase consists of the following files:

app.js: The main application file that contains the wallet management and token transfer logic.
agent_wallet.json: A file that stores the wallet keypair data.
package.json: A file that contains the project metadata and dependencies.
Dependencies
The project depends on the following packages:

@solana/web3.js: A library for interacting with the Solana blockchain.
bs58: A library for encoding and decoding base58 strings.
Wallet Management
The application uses the solanaWeb3 library to create and manage a Solana wallet. The wallet keypair data is stored in the agent_wallet.json file.

Creating a Wallet
The getAgentWallet function checks if a wallet file exists. If it does, it loads the wallet data from the file. If not, it generates a new wallet keypair and stores it in the file.

Checking Balance
The checkWalletBalance function takes a public key string as input and returns the balance of the corresponding wallet.

Sending SOL
The sendSol function takes a recipient address and an amount as input and sends the specified amount of SOL to the recipient address.

HTTP Server
The application sets up an HTTP server that listens for POST requests to the /trigger endpoint. When a request is received, it parses the request body and extracts the recipient address and other data. It then sends the specified amount of SOL to the recipient address using the sendSol function.

Running the Application
