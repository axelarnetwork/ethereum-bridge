# Axelar cross-chain gateway protocol solidity implementation

## Protocol overview

Axelar is a decentralized interoperability network connecting all blockchains, assets and apps through a universal set of protocols and APIs.
It is built on top of the Cosmos SDK. Users/Applications can use Axelar network to send tokens between any Cosmos and EVM chains. They can also
send arbitrary messages between EVM chains.

Axelar network's decentralized validators confirm events emitted on EVM chains (such as deposit confirmation and message send),
and sign off on commands submitted (by automated services) to the gateway smart contracts (such as minting token, and approving message on the destination).

See [this doc](./DESIGN.md) for more design info.

## Build

We recommend using the latest Node.js [LTS version](https://nodejs.org/en/about/releases/).

```bash
npm ci

npm run build

npm run test
```

Pre-compiled bytecodes can be found under [Releases](https://github.com/axelarnetwork/axelar-cgp-solidity/releases).
Furthermore, pre-compiled bytecodes and ABI are shipped in the [npm package](https://www.npmjs.com/package/@axelar-network/axelar-cgp-solidity) and can be imported via:

```bash
npm i @axelar-network/axelar-cgp-solidity
```

```javascript
const IAxelarGateway = require('@axelar-network/axelar-cgp-solidity/artifacts/interfaces/IAxelarGateway.json');

const AxelarGateway = require('@axelar-network/axelar-cgp-solidity/artifacts/contracts/AxelarGateway.sol/AxelarGateway.json');
```

## Deploying contracts

See the Axelar contract deployments [repository](https://github.com/axelarnetwork/axelar-contract-deployments) for relevant deployment/upgrade scripts:

1. [Gateway deployment](https://github.com/axelarnetwork/axelar-contract-deployments/tree/main/evm#axelargateway)
2. [Gateway upgrade](https://github.com/axelarnetwork/axelar-contract-deployments/tree/main/evm#gateway-upgrade)
3. [Gas service and deposit service deployment and upgrades](https://github.com/axelarnetwork/axelar-contract-deployments/tree/main/evm#axelargasservice-and-axelardepositservice)

## Live network testing

1. Check if the contract deployments repository supports the chain you will be using. Supported chains can be found [here](https://github.com/axelarnetwork/axelar-contract-deployments/tree/main/axelar-chains-config). If the chain is not already supported, proceed to steps 2-4, otherwise you may skip to step 5.
2. Navigate to the contract deployments repo [here](https://github.com/axelarnetwork/axelar-contract-deployments/) and clone the repository locally.
3. Within the contract deployments repo, edit the environment specific file inside the `axelar-chains-config/info` folder to add the chain you'll be testing. The following values need to be provided:

```json
{
    "chains": {
        "example": {
            "name": "Example",
            "axelarId": "example",
            "chainId": 123,
            "rpc": "PROVIDER_RPC",
            "tokenSymbol": "EXM",
            "gasOptions": {
                "gasLimit": 8000000
            },
            "confirmations": 1
        }
    }
}
```

`gasLimit` override will skip auto gas estimation (which might be unreliable on certain chains for certain txs). `confirmations` indicates the number of block confirmations to wait for. `axelarId` is the unique id used to reference the chain on Axelar.

4. Return to the `axelar-cgp-solidity` repository. Once there, in the root directory of this repository, navigate to the `hardhat.config.js` file and modify the chains import line as shown below:

```javascript
const chains = require(`/path/to/axelar-contract-deployments/axelar-chains-config/info/${env}.json`);
```

5. Create a `keys.json` file in this repo that contains the private keys for your accounts that will be used for testing. For some tests, such as the Axelar gateway tests, you may need to provide at least two private keys (you can refer the [test](https://github.com/axelarnetwork/axelar-cgp-solidity/blob/d0c040330d7498d52dee7eedbebf2aefeb5c87fb/test/BurnableMintableCappedERC20.js#L22) to find the number of accounts needed). At this point the `keys.json` file should resemble the example file below (`chains` can be left empty):

```json
{
    "chains": {},
    "accounts": ["PRIVATE_KEY1", "PRIVATE_KEY2"]
}
```

6. Ensure that your accounts corresponding to the private keys provided have sufficient gas tokens on the chain.
7. Run

```bash
npm ci

npx hardhat test --network example
```

8. To run specific tests you may modify the test scripts by adding `.only` to `describe` and/or `it` blocks as shown below or grep the specific test names:

```javascript
describe.only();
it.only();
```

```bash
npx hardhat test --network example --grep 'AxelarGateway'
```

## Debugging Steps

-   Explicitly pass `getGasOptions()` using utils.js file for some specific transactions. See the code below for example

```javascript
await sourceChainGateway
    .execute(
        await getSignedWeightedExecuteInput(await getTokenDeployData(false), [operatorWallet], [1], 1, [operatorWallet]),
        getGasOptions()
    )
    .then((tx) => tx.wait(network.config.confirmations));
```

-   Using the most up to date and fast rpc can help in tests execution runtime. Make sure the rate limit for the rpc is not exceeded.

-   Make sure that the account being used to broadcast transactions has enough native balance. The maximum `gasLimit` for a chain should be fetched from an explorer and set it in config file. You may also need to update the `confirmations` required for a transaction to be successfully included in a block in the config [here](https://github.com/axelarnetwork/axelar-contract-deployments/tree/main/axelar-chains-config/info) depending on the network.

-   Note that certain tests can require upto 3 accounts.

-   Transactions can fail if previous transactions are not mined and picked up by the provide, therefore wait for a transaction to be mined after broadcasting. See the code below for example

```javascript
await testToken.mint(userWallet.address, 1e9).then((tx) => tx.wait(network.config.confirmations));

// Or

const txExecute = await interchainGovernance.execute(commandIdGateway, governanceChain, governanceAddress, payload, getGasOptions());
const receiptExecute = await txExecute.wait(network.config.confirmations);
```

-   The `changeEtherBalance` check expects one tx in a block so change in balances might need to be tested explicitly for unit tests using `changeEtherBalance`.

## Example flows

See Axelar [examples](https://github.com/axelarnetwork/axelar-examples) for concrete examples.

### Token transfer

1. Setup: A wrapped version of Token `A` is deployed (`AxelarGateway.deployToken()`)
   on each non-native EVM chain as an ERC-20 token (`BurnableMintableCappedERC20.sol`).
2. Given the destination chain and address, Axelar network generates a deposit address (the address where `DepositHandler.sol` is deployed,
   `BurnableMintableCappedERC20.depositAddress()`) on source EVM chain.
3. User sends their token `A` at that address, and the deposit contract locks the token at the gateway (or burns them for wrapped tokens).
4. Axelar network validators confirm the deposit `Transfer` event using their RPC nodes for the source chain (using majority voting).
5. Axelar network prepares a mint command, and validators sign off on it.
6. Signed command is now submitted (via any external relayer) to the gateway contract on destination chain `AxelarGateway.execute()`.
7. Gateway contract authenticates the command, and `mint`'s the specified amount of the wrapped Token `A` to the destination address.

### Token transfer via AxelarDepositService

1. User wants to send wrapped token like WETH from chain A back to the chain B and to be received in native currency like Ether.
2. The un-wrap deposit address is generated by calling `AxelarDepositService.addressForNativeUnwrap()`.
3. The token transfer deposit address for specific transfer is generated by calling `AxelarDepositService.addressForTokenDeposit()` with using the un-wrap address as a destination.
4. User sends the wrapped token to that address on the source chain A.
5. Axelar microservice detects the token transfer to that address and calls `AxelarDepositService.sendTokenDeposit()`.
6. `AxelarDepositService` deploys `DepositReceiver` to that generated address which will call `AxelarGateway.sendToken()`.
7. Axelar network prepares a mint command, and it gets executed on the destination chain gateway.
8. Wrapped token gets minted to the un-wrap address on the destination chain B.
9. Axelar microservice detects the token transfer to the un-wrap address and calls `AxelarDepositService.nativeUnwrap()`.
10. `AxelarDepositService` deploys `DepositReceiver` which will call `IWETH9.withdraw()` and transfer native currency to the recipient address.

### Cross-chain smart contract call

1. Setup:
    1. Destination contract implements the `IAxelarExecutable.sol` interface to receive the message.
    2. If sending a token, source contract needs to call `ERC20.approve()` beforehand to allow the gateway contract
       to transfer the specified `amount` on behalf of the sender/source contract.
2. Smart contract on source chain calls `AxelarGateway.callContractWithToken()` with the destination chain/address, `payload` and token.
3. An external service stores `payload` in a regular database, keyed by the `hash(payload)`, that anyone can query by.
4. Similar to above, Axelar validators confirm the `ContractCallWithToken` event.
5. Axelar network prepares an `AxelarGateway.approveContractCallWithMint()` command, signed by the validators.
6. This is submitted to the gateway contract on the destination chain,
   which records the approval of the `payload hash` and emits the event `ContractCallApprovedWithMint`.
7. Any external relayer service listens to this event on the gateway contract, and calls the `IAxelarExecutable.executeWithToken()`
   on the destination contract, with the `payload` and other data as params.
8. `executeWithToken` of the destination contract verifies that the contract call was indeed approved by calling `AxelarGateway.validateContractCallAndMint()`
   on the gateway contract.
9. As part of this, the gateway contract records that the destination address has validated the approval, to not allow a replay.
10. The destination contract uses the `payload` for its own application.

## References

Network resources: https://docs.axelar.dev/resources

Deployed contracts: https://docs.axelar.dev/resources/mainnet

General Message Passing Usage: https://docs.axelar.dev/dev/gmp

Example cross-chain token swap app: https://app.squidrouter.com

EVM module of the Axelar network that prepares commands for the gateway: https://github.com/axelarnetwork/axelar-core/blob/main/x/evm/keeper/msg_server.go
