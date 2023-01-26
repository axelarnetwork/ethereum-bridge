'use strict';
require('dotenv').config();
const _ = require('lodash/fp');
const {
    Wallet,
    getDefaultProvider,
    utils: { isAddress },
    ContractFactory,
} = require('ethers');
const { deployUpgradable, upgradeUpgradable, getProxy } = require('./upgradable');
const readlineSync = require('readline-sync');
const { outputJsonSync } = require('fs-extra');

async function getImplementationArgs(contractName, chain, wallet, artifactPath) {
    if (contractName === 'AxelarGasService') {
        const collector = _.get('AxelarGasService.collector', chain);
        if (!isAddress(collector)) throw new Error(`Missing AxelarGasService.collector in the chain info.`);
        return [collector];
    }

    if (contractName === 'AxelarDepositService') {
        const symbol = _.getOr('', 'AxelarDepositService.wrappedSymbol', chain);
        if (_.isEmpty(symbol)) console.log(`${chain.name} | AxelarDepositService.wrappedSymbol: wrapped token is disabled`);

        const refundIssuer = _.get('AxelarDepositService.refundIssuer', chain);
        if (!isAddress(refundIssuer)) throw new Error(`Missing AxelarDepositService.refundIssuer in the chain info.`);

        return [chain.gateway, symbol, refundIssuer];
    }

    if (contractName === 'GMPExpressService') {
        const gasService = _.get('AxelarGasService.address', chain);
        if (!isAddress(gasService)) throw new Error(`Missing AxelarGasService.address in the chain info.`);

        const expressOperator = _.get('GMPExpressService.expressOperator', chain);
        if (!isAddress(expressOperator)) throw new Error(`Missing GMPExpressService.expressOperator in the chain info.`);

        let proxyDeployer = _.get('GMPExpressService.proxyDeployer', chain);

        if (!isAddress(proxyDeployer)) {
            const deployerJson = require(`${artifactPath}ExpressProxyDeployer.sol/ExpressProxyDeployer.json`);
            const deployerFactory = new ContractFactory(deployerJson.abi, deployerJson.bytecode, wallet);
            const deployer = await deployerFactory.deploy(chain.gateway);
            await deployer.deployed();

            proxyDeployer = deployer.address;
            chain.GMPExpressService.proxyDeployer = proxyDeployer;

            console.log(`${chain.name} | GMPExpressService: deployed a new ExpressProxyDeployer at ${proxyDeployer}`);
        }

        return [chain.gateway, gasService, proxyDeployer, expressOperator];
    }

    throw new Error(`${contractName} is not supported.`);
}

function getInitArgs(contractName, chain) {
    if (contractName === 'AxelarGasService') return '0x';
    if (contractName === 'AxelarDepositService') return '0x';
    if (contractName === 'GMPExpressService') return '0x';
    throw new Error(`${contractName} is not supported.`);
}

function getUpgradeArgs(contractName, chain) {
    if (contractName === 'AxelarGasService') return '0x';
    if (contractName === 'AxelarDepositService') return '0x';
    if (contractName === 'GMPExpressService') return '0x';
    throw new Error(`${contractName} is not supported.`);
}

async function deploy(env, chains, wallet, artifactPath, contractName, deployTo) {
    const setJSON = (data, name) => {
        outputJsonSync(name, data, {
            spaces: 2,
            EOL: '\n',
        });
    };

    const implementationPath = artifactPath + contractName + '.sol/' + contractName + '.json';
    const proxyPath = artifactPath + contractName + 'Proxy.sol/' + contractName + 'Proxy.json';
    const implementationJson = require(implementationPath);
    const proxyJson = require(proxyPath);
    console.log(`Deployer address ${wallet.address}`);

    for (const chain of chains) {
        if (deployTo.length > 0 && !deployTo.find((name) => chain.name === name)) continue;
        const rpc = chain.rpc;
        const provider = getDefaultProvider(rpc);
        console.log(
            `Deployer has ${(await provider.getBalance(wallet.address)) / 1e18} ${
                chain.tokenSymbol
            } and nonce ${await provider.getTransactionCount(wallet.address)} on ${chain.name}.`,
        );
    }

    const anwser = readlineSync.question('Proceed with deployment? (y/n) ');
    if (anwser !== 'y') return;

    for (const chain of chains) {
        try {
            if (deployTo.length > 0 && !deployTo.find((name) => chain.name === name)) continue;
            const rpc = chain.rpc;
            const provider = getDefaultProvider(rpc);

            if (chain[contractName] && chain[contractName]['address']) {
                const contract = getProxy(wallet.connect(provider), chain[contractName]['address']);
                console.log(`Proxy already exists for ${chain.name}`);
                console.log(`Existing implementation ${await contract.implementation()}`);
                const anwser = readlineSync.question(`Perform an upgrade? (y/n) `);
                if (anwser !== 'y') continue;

                await upgradeUpgradable(
                    wallet.connect(provider),
                    chain[contractName]['address'],
                    implementationJson,
                    await getImplementationArgs(contractName, chain, wallet.connect(provider), artifactPath),
                    getUpgradeArgs(contractName, chain),
                );

                chain[contractName]['implementation'] = await contract.implementation();

                console.log(`${chain.name} | New Implementation for ${contractName} is at ${chain[contractName]['implementation']}`);
                console.log(`${chain.name} | Upgraded.`);
            } else {
                const key = env.includes('devnet') ? `${contractName}-${env}` : contractName;

                const contract = await deployUpgradable(
                    chain.constAddressDeployer,
                    wallet.connect(provider),
                    implementationJson,
                    proxyJson,
                    await getImplementationArgs(contractName, chain, wallet.connect(provider), artifactPath),
                    [],
                    getInitArgs(contractName, chain),
                    key,
                );

                chain[contractName] = {
                    ...chain[contractName],
                    salt: key,
                    address: contract.address,
                    implementation: await contract.implementation(),
                    deployer: wallet.address,
                };

                console.log(`${chain.name} | ConstAddressDeployer is at ${chain.constAddressDeployer}`);
                console.log(`${chain.name} | Proxy for ${contractName} is at ${contract.address}`);
                console.log(`${chain.name} | Implementation for ${contractName} is at ${chain[contractName]['implementation']}`);
            }

            setJSON(chains, `./info/${env}.json`);
        } catch (e) {
            console.error(`${chain.name} | Error:`);
            console.error(e);
        }
    }
}

if (require.main === module) {
    const env = process.argv[2];
    if (env === null || (env !== 'local' && !env.includes('devnet') && env !== 'testnet' && env !== 'mainnet'))
        throw new Error('Need to specify local | devnet* | testnet | mainnet as an argument to this script.');

    const chains = require(`../info/${env}.json`);

    const private_key = process.env.PRIVATE_KEY;
    const wallet = new Wallet(private_key);

    const artifactPath = process.argv[3];

    const contractName = process.argv[4];

    const deployTo = process.argv.slice(5);

    deploy(env, chains, wallet, artifactPath, contractName, deployTo);
}
