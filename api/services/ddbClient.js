const DynamoDB = require('aws-sdk/clients/dynamodb');
const localOptions = {
    region: 'localhost',
    endpoint: 'http://localhost:8000'
};

const isOffline = () => process.env.IS_OFFLINE;

module.exports = (additionalOptions) => {

    if (isOffline()) {
        const allOptions = Object.assign(localOptions, additionalOptions);
        return {
            doc: new DynamoDB.DocumentClient(allOptions),
            raw: new DynamoDB(allOptions),
            conv: DynamoDB.Converter
        }
    }
    
    return {
        doc: new DynamoDB.DocumentClient(additionalOptions),
        raw: new DynamoDB(additionalOptions),
        conv: DynamoDB.Converter
    }
};