# Solana Wallet API Documentation

## Overview

The Solana Wallet API provides a lightweight interface for handling SOL token transfers on the Solana blockchain. This API is designed to facilitate automated reward distributions for completed challenges.

## Base URL

```
http://localhost:3000
```

## Authentication

Currently, the API does not require authentication. However, proper validation of request parameters is performed to ensure security.

## Endpoints

### Transfer SOL

Triggers a transfer of SOL tokens to a specified Solana wallet address.

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
| username          | string  | Yes      | The username of the reward recipient            |
| challengeCompleted| boolean | Yes      | Flag indicating if the challenge was completed  |
| solanaAddress     | string  | Yes      | Valid Solana wallet address of the recipient    |

##### Example Request

```json
{
    "username": "testUser",
    "challengeCompleted": true,
    "solanaAddress": "YourSolanaWalletAddress"
}
```

#### Response

##### Success Response (200 OK)

```json
{
    "status": "success",
    "message": "SOL sent successfully",
    "signature": "2xGVGnwqSHAQEMdHvhXGBTxzz7YdKyUnpyF1LYK3kgGHjKZRqk9PFDBNmPTPAFXmJkHE3YzNHa4Pmj8TEpgHnWHk",
    "amount": 0.000001
}
```

##### Error Responses

| Status Code | Description                                      | Response Body                                    |
|------------|--------------------------------------------------|--------------------------------------------------|
| 400        | Invalid request data                             | `{"status": "error", "message": "Invalid request data"}` |
| 500        | Invalid public key                               | `{"status": "error", "message": "Invalid public key input"}` |
| 500        | Insufficient balance                             | `{"status": "error", "message": "Insufficient balance. Have 0 SOL, need 0.1 SOL"}` |

## Rate Limiting

Currently, there are no rate limits implemented. However, transactions are limited by:
- Solana network throughput
- Available SOL balance in the sender's wallet
- Network fees

## Code Examples

### JavaScript/TypeScript

```typescript
const transferSOL = async (username: string, solanaAddress: string) => {
  try {
    const response = await fetch('http://localhost:3000/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username,
        challengeCompleted: true,
        solanaAddress,
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

```bash
curl -X POST http://localhost:3000/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testUser",
    "challengeCompleted": true,
    "solanaAddress": "YourSolanaWalletAddress"
  }'
```

## Testing

A Postman collection is available for testing the API endpoints. Import the provided `solana-wallet-api.postman_collection.json` file into Postman to get started.

## Best Practices

1. Always validate Solana addresses before making transfer requests
2. Handle network errors and timeouts appropriately
3. Implement proper error handling for failed transactions
4. Monitor transaction status using the returned signature

## Changelog

### Version 1.0.0 (Initial Release)
- Implemented SOL transfer endpoint
- Added basic error handling
- Included transaction signature in successful responses

## Support

For issues and feature requests, please contact the development team or create an issue in the repository. 