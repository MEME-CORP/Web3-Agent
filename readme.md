# Solana Web3 Agent Server

A Node.js server that manages Solana wallet operations and handles automated SOL transfers on the Solana devnet network.

## Deployed Server
The server is currently deployed and accessible at:
https://web3-agent.onrender.com

## Features
- Automated SOL transfers (0.001 SOL per successful challenge)
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

## Environment Variables
Create a `.env` file in the root directory with the following variables:

# Solana Wallet Configuration
WALLET_PUBLIC_KEY=your_public_key_here
WALLET_PRIVATE_KEY=your_private_key_here
WALLET_SECRET_KEY=your_secret_key_array_here

# Network Configuration
SOLANA_NETWORK=devnet

# Server Configuration
PORT=3000 