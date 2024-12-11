# Solana Web3 Agent Server

A Node.js server that manages Solana wallet operations and handles automated SOL transfers on the Solana devnet network.

## Deployed Server
The server is currently deployed and accessible at:
https://web3-agent.onrender.com

## Features
- Automated SOL transfers (0.001 SOL per successful challenge)
- Fresh wallet generation endpoint
- Environment-based wallet configuration
- Balance checking functionality
- Secure transaction handling
- Comprehensive error handling and logging

## Tech Stack
- Node.js
- Solana Web3.js
- Base58 encoding/decoding

## Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Solana CLI (optional, for local testing)
- A Solana wallet with devnet SOL

## Local Development Setup

1. **Clone the repository**
   ```bash
   git clone [your-repo-url]
   cd [your-repo-name]
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   Create a `.env` file in the root directory with:
   ```
   # Treasury Wallet Configuration
   TREASURY_PRIVATE_KEY=your_base58_encoded_private_key
   
   # Network Configuration
   SOLANA_NETWORK=devnet
   
   # Server Configuration
   PORT=3000
   ```

4. **Start the server**
   ```bash
   node app.js
   ```

5. **Test the endpoints**
   The server will be running at `http://localhost:3000` with the following endpoints:
   - POST `/create-wallet`: Generates a new Solana wallet
   - POST `/trigger`: Sends SOL to a specified address

## Testing with Postman
Import the provided `postman_collection.json` to test the API endpoints.

## Environment Variables
Create a `.env` file in the root directory with the following variables:


# Network Configuration
SOLANA_NETWORK=devnet

# Server Configuration
PORT=3000 


#Testnet Tokens

https://solfaucet.com/

