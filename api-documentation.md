# Solana Wallet API Documentation

## Overview

The Solana Wallet API provides a lightweight interface for handling SOL token transfers and wallet generation on the Solana blockchain. This API is designed to facilitate automated reward distributions and wallet management.

## Base URL

```
https://web3-agent.onrender.com
```

## Authentication

Currently, the API does not require authentication. However, proper validation of request parameters is performed to ensure security.

## Endpoints

### 1. Generate Wallet

Creates a new Solana wallet and returns the public and private keys.

```http
POST /generate-wallet
```

#### Request

##### Headers

| Name          | Type   | Required | Description            |
|---------------|--------|----------|------------------------|
| Content-Type  | string | Yes      | application/json       |

#### Response

##### Success Response (200 OK)

```json
{
    "status": "success",
    "message": "Wallet generated successfully",
    "wallet": {
        "publicKey": "GENERATED_PUBLIC_KEY",
        "privateKey": "GENERATED_PRIVATE_KEY"
    }
}
```

##### Error Response (500 Internal Server Error)

```json
{
    "status": "error",
    "message": "Error message details"
}
```

### 2. Transfer SOL

Triggers a transfer of SOL tokens from one wallet to another.

```http
POST /trigger
```

#### Request

##### Headers

| Name          | Type   | Required | Description            |
|---------------|--------|----------|------------------------|
| Content-Type  | string | Yes      | application/json       |

##### Body Parameters

| Parameter          | Type    | Required | Description                                     |
|-------------------|---------|----------|-------------------------------------------------|
| fromPrivateKey    | string  | Yes      | Private key of the sending wallet               |
| fromPublicKey     | string  | Yes      | Public key of the sending wallet                |
| toAddress         | string  | Yes      | Recipient's Solana wallet address               |
| amount            | number  | Yes      | Amount of SOL to transfer                       |
| username          | string  | No       | Username of the recipient (optional)            |
| challengeCompleted| boolean | No       | Flag indicating challenge completion (optional)  |

##### Example Request

```json
{
    "username": "testUser",
    "challengeCompleted": true,
    "fromPrivateKey": "YOUR_PRIVATE_KEY",
    "fromPublicKey": "YOUR_PUBLIC_KEY",
    "toAddress": "RECIPIENT_SOLANA_ADDRESS",
    "amount": 0.001
}
```

#### Response

##### Success Response (200 OK)

```json
{
    "status": "success",
    "message": "SOL sent successfully",
    "signature": "2xGVGnwqSHAQEMdHvhXGBTxzz7YdKyUnpyF1LYK3kgGHjKZRqk9PFDBNmPTPAFXmJkHE3YzNHa4Pmj8TEpgHnWHk",
    "amount": 0.001
}
```

##### Error Responses

| Status Code | Description                                      | Response Body                                    |
|------------|--------------------------------------------------|--------------------------------------------------|
| 400        | Invalid request data                             | `{"status": "error", "message": "Invalid request data"}` |
| 500        | Invalid public key                               | `{"status": "error", "message": "Invalid public key input"}` |
| 500        | Insufficient balance                             | `{"status": "error", "message": "Insufficient balance. Have X SOL, need Y SOL"}` |
| 500        | Key mismatch                                     | `{"status": "error", "message": "Provided public key does not match the private key"}` |

### 3. Check Wallet Balance

Retrieves the current balance of a Solana wallet.

```http
POST /check-balance
```

#### Request

##### Headers

| Name          | Type   | Required | Description            |
|---------------|--------|----------|------------------------|
| Content-Type  | string | Yes      | application/json       |

##### Body Parameters

| Parameter  | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| publicKey | string | Yes      | Public key of the wallet       |

##### Example Request

```json
{
    "publicKey": "YOUR_PUBLIC_KEY"
}
```

#### Response

##### Success Response (200 OK)

```json
{
    "status": "success",
    "message": "Balance retrieved successfully",
    "balance": 1.5,
    "lamports": 1500000000
}
```

##### Error Responses

| Status Code | Description           | Response Body                                    |
|-------------|-----------------------|--------------------------------------------------|
| 400         | Invalid request data  | `{"status": "error", "message": "Invalid request data"}` |
| 500         | Invalid public key    | `{"status": "error", "message": "Invalid public key"}` |

## Rate Limiting

Currently, there are no rate limits implemented. However, transactions are limited by:
- Solana network throughput
- Available SOL balance in the sender's wallet
- Network fees

## Code Examples

### JavaScript/TypeScript

#### Generate Wallet
```typescript
const generateWallet = async () => {
  try {
    const response = await fetch('http://localhost:3000/generate-wallet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
```

#### Transfer SOL
```typescript
const transferSOL = async (fromPrivateKey: string, fromPublicKey: string, toAddress: string, amount: number) => {
  try {
    const response = await fetch('http://localhost:3000/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromPrivateKey,
        fromPublicKey,
        toAddress,
        amount
      }),
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
```

#### Check Balance
```typescript
const checkBalance = async (publicKey: string) => {
  try {
    const response = await fetch('https://web3-agent.onrender.com/check-balance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        publicKey
      }),
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
```

### cURL

#### Generate Wallet
```bash
curl -X POST http://localhost:3000/generate-wallet \
  -H "Content-Type: application/json"
```

#### Transfer SOL
```bash
curl -X POST http://localhost:3000/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "fromPrivateKey": "YOUR_PRIVATE_KEY",
    "fromPublicKey": "YOUR_PUBLIC_KEY",
    "toAddress": "RECIPIENT_ADDRESS",
    "amount": 0.001
  }'
```

#### Check Balance
```bash
curl -X POST https://web3-agent.onrender.com/check-balance \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "YOUR_PUBLIC_KEY"
  }'
```

## Testing

A Postman collection is provided for testing both API endpoints. Import the provided `postman_collection.json` file into Postman to get started.

## Best Practices

1. Always validate Solana addresses before making transfer requests
2. Never expose private keys in client-side code
3. Implement proper error handling for failed transactions
4. Monitor transaction status using the returned signature
5. Store private keys securely and never log them
6. Use HTTPS in production environments

## Changelog

### Version 1.1.0
- Added wallet generation endpoint
- Updated transfer endpoint to accept sender credentials
- Improved error handling and validation
- Added key pair validation

### Version 1.0.0 (Initial Release)
- Implemented SOL transfer endpoint
- Added basic error handling
- Included transaction signature in successful responses

### Version 1.2.0
- Added wallet balance checking endpoint
- Added balance information in lamports and SOL

## Support

For issues and feature requests, please contact the development team or create an issue in the repository. 