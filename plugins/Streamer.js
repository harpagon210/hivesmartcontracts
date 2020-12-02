const dhive = require('@hiveio/dhive');
const { Queue } = require('../libs/Queue');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const { Database } = require('../libs/Database');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Streamer.constants');

const ipc = new IPC(PLUGIN_NAME);
let client = null;
let database = null;
class ForkException {
  constructor(message) {
    this.error = 'ForkException';
    this.message = message;
  }
}

let currentHiveBlock = 0;
let hiveHeadBlockNumber = 0;
let stopStream = false;
const antiForkBufferMaxSize = 2;
const buffer = new Queue(antiForkBufferMaxSize);
let chainIdentifier = '';
let blockStreamerHandler = null;
let updaterGlobalPropsHandler = null;
let lastBlockSentToBlockchain = 0;

const getCurrentBlock = () => currentHiveBlock;

const stop = () => {
  stopStream = true;
  if (blockStreamerHandler) clearTimeout(blockStreamerHandler);
  if (updaterGlobalPropsHandler) clearTimeout(updaterGlobalPropsHandler);
  if (database) database.close();
  return lastBlockSentToBlockchain;
};

// parse the transactions found in a Hive block
const parseTransactions = (refBlockNumber, block) => {
  const newTransactions = [];
  const transactionsLength = block.transactions.length;

  for (let i = 0; i < transactionsLength; i += 1) {
    const nbOperations = block.transactions[i].operations.length;

    for (let indexOp = 0; indexOp < nbOperations; indexOp += 1) {
      const operation = block.transactions[i].operations[indexOp];

      if (operation[0] === 'custom_json'
        || operation[0] === 'transfer'
        || operation[0] === 'comment'
        || operation[0] === 'comment_options'
        || operation[0] === 'vote'
      ) {
        try {
          let id = null;
          let sender = null;
          let recipient = null;
          let amount = null;
          let permlink = null;
          let sscTransactions = [];
          let isSignedWithActiveKey = null;

          if (operation[0] === 'custom_json') {
            id = operation[1].id; // eslint-disable-line prefer-destructuring
            if (operation[1].required_auths.length > 0) {
              sender = operation[1].required_auths[0]; // eslint-disable-line
              isSignedWithActiveKey = true;
            } else {
              sender = operation[1].required_posting_auths[0]; // eslint-disable-line
              isSignedWithActiveKey = false;
            }
            let jsonObj = JSON.parse(operation[1].json); // eslint-disable-line
            sscTransactions = Array.isArray(jsonObj) ? jsonObj : [jsonObj];
          } else if (operation[0] === 'transfer') {
            isSignedWithActiveKey = true;
            sender = operation[1].from;
            recipient = operation[1].to;
            amount = operation[1].amount; // eslint-disable-line prefer-destructuring
            const transferParams = JSON.parse(operation[1].memo);
            id = transferParams.id; // eslint-disable-line prefer-destructuring
            // multi transactions is not supported for the Hive transfers
            if (Array.isArray(transferParams.json) && transferParams.json.length === 1) {
              sscTransactions = transferParams.json;
            } else if (!Array.isArray(transferParams.json)) {
              sscTransactions = [transferParams.json];
            }
          } else if (operation[0] === 'comment') {
            sender = operation[1].author;
            const commentMeta = operation[1].json_metadata !== '' ? JSON.parse(operation[1].json_metadata) : null;

            if (commentMeta && commentMeta.ssc) {
              id = commentMeta.ssc.id; // eslint-disable-line prefer-destructuring
              sscTransactions = commentMeta.ssc.transactions;
              permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring
            } else {
              const commentBody = JSON.parse(operation[1].body);
              id = commentBody.id; // eslint-disable-line prefer-destructuring
              sscTransactions = Array.isArray(commentBody.json)
                ? commentBody.json : [commentBody.json];
            }
          } else if (operation[0] === 'comment_options') {
            id = `ssc-${chainIdentifier}`;
            sender = 'null';
            permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring

            const extensions = operation[1].extensions; // eslint-disable-line prefer-destructuring
            let beneficiaries = [];
            if (extensions
              && extensions[0] && extensions[0].length > 1
              && extensions[0][1].beneficiaries) {
              beneficiaries = extensions[0][1].beneficiaries; // eslint-disable-line
            }

            sscTransactions = [
              {
                contractName: 'comments',
                contractAction: 'commentOptions',
                contractPayload: {
                  author: operation[1].author,
                  maxAcceptedPayout: operation[1].max_accepted_payout,
                  allowVotes: operation[1].allow_votes,
                  allowCurationRewards: operation[1].allow_curation_rewards,
                  beneficiaries,
                },
              },
            ];
          } else if (operation[0] === 'vote') {
            id = `ssc-${chainIdentifier}`;
            sender = 'null';
            permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring

            sscTransactions = [
              {
                contractName: 'comments',
                contractAction: 'vote',
                contractPayload: {
                  voter: operation[1].voter,
                  author: operation[1].author,
                  weight: operation[1].weight,
                },
              },
            ];
          }

          if (id && id === `ssc-${chainIdentifier}` && sscTransactions.length > 0) {
            const nbTransactions = sscTransactions.length;
            for (let index = 0; index < nbTransactions; index += 1) {
              const sscTransaction = sscTransactions[index];

              const { contractName, contractAction, contractPayload } = sscTransaction;
              if (contractName && typeof contractName === 'string'
                && contractAction && typeof contractAction === 'string'
                && contractPayload && typeof contractPayload === 'object') {
                contractPayload.recipient = recipient;
                contractPayload.amountHIVEHBD = amount;
                contractPayload.isSignedWithActiveKey = isSignedWithActiveKey;
                contractPayload.permlink = permlink;

                if (recipient === null) {
                  delete contractPayload.recipient;
                }

                if (amount === null) {
                  delete contractPayload.amountHIVEHBD;
                }

                if (isSignedWithActiveKey === null) {
                  delete contractPayload.isSignedWithActiveKey;
                }

                if (permlink === null) {
                  delete contractPayload.permlink;
                }

                // callingContractInfo is a reserved property
                // it is used to provide information about a contract when calling
                // a contract action from another contract
                if (contractPayload.callingContractInfo) {
                  delete contractPayload.callingContractInfo;
                }

                // set the sender to null when calling the comment action
                // this way we allow people to create comments only via the comment operation
                if (operation[0] === 'comment' && contractName === 'comments' && contractAction === 'comment') {
                  contractPayload.author = sender;
                  sender = 'null';
                }

                // if multi transactions
                // append the index of the transaction to the Hive transaction id
                let SSCtransactionId = block.transaction_ids[i];

                if (nbOperations > 1) {
                  SSCtransactionId = `${SSCtransactionId}-${indexOp}`;
                }

                if (nbTransactions > 1) {
                  SSCtransactionId = `${SSCtransactionId}-${index}`;
                }

                /* console.log( // eslint-disable-line no-console
                  'sender:',
                  sender,
                  'recipient',
                  recipient,
                  'amount',
                  amount,
                  'contractName:',
                  contractName,
                  'contractAction:',
                  contractAction,
                  'contractPayload:',
                  contractPayload,
                ); */

                newTransactions.push(
                  new Transaction(
                    refBlockNumber,
                    SSCtransactionId,
                    sender,
                    contractName,
                    contractAction,
                    JSON.stringify(contractPayload),
                  ),
                );
              }
            }
          }
        } catch (e) {
          // console.error('Invalid transaction', e); // eslint-disable-line no-console
        }
      }
    }
  }

  return newTransactions;
};

const sendBlock = block => ipc.send(
  { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block },
);

const getLatestBlockMetadata = () => database.getLatestBlockMetadata();

// process Hive block
const processBlock = async (block) => {
  if (stopStream) return;

  await sendBlock(
    {
      // we timestamp the block with the Hive block timestamp
      timestamp: block.timestamp,
      refHiveBlockNumber: block.blockNumber,
      refHiveBlockId: block.block_id,
      prevRefHiveBlockId: block.previous,
      transactions: parseTransactions(
        block.blockNumber,
        block,
      ),
    },
  );

  lastBlockSentToBlockchain = block.blockNumber;
};

const updateGlobalProps = async () => {
  try {
    if (client !== null) {
      const globProps = await client.database.getDynamicGlobalProperties();
      hiveHeadBlockNumber = globProps.head_block_number;
      const delta = hiveHeadBlockNumber - currentHiveBlock;
      // eslint-disable-next-line
      console.log(`head_block_number ${hiveHeadBlockNumber}`, `currentBlock ${currentHiveBlock}`, `Hive blockchain is ${delta > 0 ? delta : 0} blocks ahead`);
    }
    updaterGlobalPropsHandler = setTimeout(() => updateGlobalProps(), 10000);
  } catch (ex) {
    console.error('An error occured while trying to fetch the Hive blockchain global properties'); // eslint-disable-line no-console
  }
};

const addBlockToBuffer = async (block) => {
  const finalBlock = block;
  finalBlock.blockNumber = currentHiveBlock;

  // if the buffer is full
  if (buffer.size() + 1 > antiForkBufferMaxSize) {
    const lastBlock = buffer.last();

    // we can send the oldest block of the buffer to the blockchain plugin
    if (lastBlock) {
      await processBlock(lastBlock);
    }
  }
  buffer.push(finalBlock);
};

const streamBlocks = async (reject) => {
  if (stopStream) return;
  try {
    const block = await client.database.getBlock(currentHiveBlock);
    let addBlockToBuf = false;

    if (block) {
      // check if there are data in the buffer
      if (buffer.size() > 0) {
        const lastBlock = buffer.first();
        if (lastBlock.block_id === block.previous) {
          addBlockToBuf = true;
        } else {
          buffer.clear();
          const msg = `a fork happened between block ${currentHiveBlock - 1} and block ${currentHiveBlock}`;
          currentHiveBlock = lastBlockSentToBlockchain + 1;
          throw new ForkException(msg);
        }
      } else {
        // get the previous block
        const prevBlock = await client.database.getBlock(currentHiveBlock - 1);

        if (prevBlock && prevBlock.block_id === block.previous) {
          addBlockToBuf = true;
        } else {
          throw new ForkException(`a fork happened between block ${currentHiveBlock - 1} and block ${currentHiveBlock}`);
        }
      }

      // add the block to the buffer
      if (addBlockToBuf === true) {
        await addBlockToBuffer(block);
      }
      currentHiveBlock += 1;
      streamBlocks(reject);
    } else {
      blockStreamerHandler = setTimeout(() => {
        streamBlocks(reject);
      }, 500);
    }
  } catch (err) {
    reject(err);
  }
};

const initHiveClient = (node, hiveAddressPrefix, hiveChainId) => {
  client = new dhive.Client(node, {
    addressPrefix: hiveAddressPrefix,
    chainId: hiveChainId,
  });
};

const startStreaming = (conf) => {
  const {
    streamNodes,
    chainId,
    startHiveBlock,
    hiveAddressPrefix,
    hiveChainId,
  } = conf;
  currentHiveBlock = startHiveBlock;
  chainIdentifier = chainId;
  const node = streamNodes[0];
  initHiveClient(node, hiveAddressPrefix, hiveChainId);

  return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
    console.log('Starting Hive streaming at ', node); // eslint-disable-line no-console

    streamBlocks(reject);
  }).catch((err) => {
    console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
    streamNodes.push(streamNodes.shift());
    startStreaming(Object.assign({}, conf, { startHiveBlock: getCurrentBlock() }));
  });
};

// stream the Hive blockchain to find transactions related to the sidechain
const init = async (conf) => {
  const {
    databaseURL,
    databaseName,
  } = conf;
  const finalConf = conf;

  database = new Database();
  await database.init(databaseURL, databaseName);
  // get latest block metadata to ensure that startHiveBlock saved in the config.json is not lower
  const block = await getLatestBlockMetadata();
  if (block) {
    if (finalConf.startHiveBlock < block.refHiveBlockNumber) {
      console.log('adjusted startHiveBlock automatically as it was lower that the refHiveBlockNumber available'); // eslint-disable-line no-console
      finalConf.startHiveBlock = block.refHiveBlockNumber + 1;
    }
  }

  startStreaming(conf);
  updateGlobalProps();
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  switch (action) {
    case 'init':
      init(payload);
      ipc.reply(message);
      console.log('successfully initialized'); // eslint-disable-line no-console
      break;
    case 'stop':
      ipc.reply(message, stop());
      console.log('successfully stopped'); // eslint-disable-line no-console
      break;
    case PLUGIN_ACTIONS.GET_CURRENT_BLOCK:
      ipc.reply(message, getCurrentBlock());
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
