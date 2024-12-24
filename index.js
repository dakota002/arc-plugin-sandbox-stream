let _arcFunctions = require('@architect/functions')
const { DynamoDBClient, DescribeTableCommand, UpdateTableCommand } = require("@aws-sdk/client-dynamodb")
const { DynamoDBStreamsClient, GetRecordsCommand, DescribeStreamCommand, GetShardIteratorCommand } = require("@aws-sdk/client-dynamodb-streams");
let defaultPollingInterval = 10000;
let retryCountRemaining = 3;
let successCount = 0;
let shardIds = [];

module.exports = {
  // Sandbox
  sandbox: {
    // Startup operations, 
    'post-seed': async ({ arc, inventory, invoke }) => {
      // This 'post-seed' thing only exists on my local, trying it for testing, I don't think it is the best way to continue, but we will see
      // Run operations upon Sandbox startup
      const pluginProperties = arc['sandbox-table-streams'];

      if (pluginProperties.length === 0) {
        console.log(`@hicksy/arc-plugin-sandbox-table-streams: Default polling interval is set to ${defaultPollingInterval}. To change, add a polling_interval property to the @sandbox-table-streams pragma in your arc manifest. eg. \n@sandbox-table-streams \npolling_interval 5000`)
      }

      for (prop of pluginProperties) {
        if (prop[0] === 'polling_interval') {
          defaultPollingInterval = prop[1];
          console.log(`@hicksy/arc-plugin-sandbox-table-streams: Polling interval read from arc manifest. Now set to poll every ${defaultPollingInterval}.`)
        }
      }

      // if(inventory.inv.aws.region !== 'ddblocal') {
      //   console.error('@hicksy/arc-plugin-sandbox-table-streams: AWS region not set to ddblocal. Plugin @hicksy/arc-plugin-sandbox-table-streams is only compatible with ddblocal. DynamoDBLocal streams will not invoke your table stream functions.')
      //   return;
      // }

      const client = await _arcFunctions.tables();
      const dynamodbClient = new DynamoDBClient({ region: inventory.inv.aws.region, endpoint: `http://localhost:${process.env.ARC_TABLES_PORT}` });
      const dynamodb_streams = new DynamoDBStreamsClient({ region: inventory.inv.aws.region, endpoint: `http://localhost:${process.env.ARC_TABLES_PORT}` });

      const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));

      const readStreamShardData = async (shardIterator, tblName) => {
        let data
        try {
          data = await dynamodb_streams.send(new GetRecordsCommand({ ShardIterator: shardIterator }))
        } catch (error) {
          console.log("Error in GetRecordsCommand: ", error.message)
        }

        if (data?.Records.length) {
          invoke({
            pragma: 'tables-streams',
            name: tblName,
            payload: data
          });
        }

        await waitFor(defaultPollingInterval);

        if (data?.NextShardIterator) {

          successCount++;

          if (successCount === 2) {
            // only show polling success message after two successful returns of NextShardIterator - seems to be a delay in the stream being ready
            console.log(`@hicksy/arc-plugin-sandbox-table-streams: Stream found for table ${tableStream.table}. Polling to invoke stream function.`)
            retryCountRemaining = 3;
          }

          readStreamShardData(data.NextShardIterator, tblName);

        } else {
          console.log(`@hicksy/arc-plugin-sandbox-table-streams: Table ${tableStream.table} stream missing NextShardIterator. Will retry ${retryCountRemaining} more times.`)
          retryCountRemaining--;
          await waitFor(3000);
        }

        initLocalStreams(false);

      }

      const initLocalStreams = async (showInitLog = true) => {

        if (!showInitLog) {
          await waitFor(defaultPollingInterval);
        }

        if (inventory.inv['tables-streams']) {

          for (tableStream of inventory.inv['tables-streams']) {
            let generatedDynamoTableName = client.name(tableStream.table);
            let shardSuccess = [];
            try {

              if (showInitLog) console.log(`@hicksy/arc-plugin-sandbox-table-streams: Attempting to connect to stream for table ${tableStream.table}`);

              let tableMetaData = await dynamodbClient.send(
                new DescribeTableCommand({ TableName: generatedDynamoTableName })
              )

              if (!tableMetaData.Table.LatestStreamArn) {
                await dynamodbClient.send(new UpdateTableCommand({
                  TableName: generatedDynamoTableName,
                  StreamSpecification: {
                    StreamEnabled: true,
                    StreamViewType: "NEW_AND_OLD_IMAGES"
                  }
                }))

                tableMetaData = await dynamodbClient.send(
                  new DescribeTableCommand({ TableName: generatedDynamoTableName })
                )
              }

              let streamMetaData = await dynamodb_streams.send(new DescribeStreamCommand({ StreamArn: tableMetaData.Table.LatestStreamArn }))

              for (shard of streamMetaData.StreamDescription.Shards) {
                let shardIteratorData = await dynamodb_streams.send(new GetShardIteratorCommand({ StreamArn: tableMetaData.Table.LatestStreamArn, ShardIteratorType: 'LATEST', ShardId: shard.ShardId }))

                if (shardIteratorData.ShardIterator) {
                  if (!shardIds.includes(shard.ShardId)) {
                    shardIds.push(shard.ShardId);
                    readStreamShardData(shardIteratorData.ShardIterator, tableStream.table);
                  }

                  shardSuccess.push(true)
                } else {
                  shardSuccess.push(false)
                }

              }

              if (shardSuccess.every(s => s !== true)) {
                throw new Error('Shards awaiting init')
              }
            } catch (e) {

              if (e.code === 'ResourceNotFoundException') {
                console.log(`@hicksy/arc-plugin-sandbox-table-streams: Table ${tableStream.table} does not exist. Using DynamoDB Local requires you to create the dynamodb table yourself (including 'StreamSpecification' config).`)
              }

              if (e.message === 'Shards awaiting init' || (e.code === 'MissingRequiredParameter' && e.message === "Missing required key 'ShardIterator' in params")) {

                if (retryCountRemaining > 0) {

                  console.log(`@hicksy/arc-plugin-sandbox-table-streams: Table ${tableStream.table} does not have a stream enabled, or table has not finished creating / seeding. Will retry ${retryCountRemaining} more times.`)
                  retryCountRemaining--;

                  await waitFor(3000);
                  initLocalStreams();
                } else {
                  console.log(`@hicksy/arc-plugin-sandbox-table-streams: Table ${tableStream.table} does not have a stream enabled.`)
                }

              }

              console.log(e)
            }


          }
        } else {
          console.error('@hicksy/arc-plugin-sandbox-table-streams: No @tables-streams pragma found in arc file. Plugin @hicksy/arc-plugin-sandbox-table-streams requires at least one @tables-streams pragma.')
        }

      }

      initLocalStreams();
    },

  }
}
