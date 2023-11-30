const AWS = require('aws-sdk');
const https = require('https');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const uuidv4 = require('uuid').v4;
const axios = require('axios');
const { createGzip } = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipe = promisify(pipeline);
let submissionUrl = ''
let userEmail =''

const ses = new AWS.SES();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const decodedPrivateKey = Buffer.from(process.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY, 'base64').toString('utf-8');
const parsedObject  = JSON.parse(decodedPrivateKey)

const storage = new Storage({
  projectId: process.env.GCP_PROJECT,
  credentials: {
      client_email: parsedObject.client_email,
      private_key: parsedObject.private_key,
      // ...other necessary fields from the service account JSON
  },
});
const bucketName = process.env.GCP_BUCKET_NAME;

// Send email notification
const sendEmail  = async (recipientEmail, subject, body) => {
  console.log('in send email file')
  const mailgunApiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  //const domain = 'demo.ashutoshraval.com';
  const mailgunUrl = `https://api.mailgun.net/v3/${domain}/messages`;

  const auth = 'Basic ' + Buffer.from(`api:${mailgunApiKey}`).toString('base64');

  const response = await axios.post(
    mailgunUrl,
    new URLSearchParams({
      from: `Your Service <mailgun@${domain}>`,
      to: recipientEmail,
      subject: subject,
      text: body,
    }),
    {
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  return response.data;
};
// Record email event in DynamoDB
const recordEmailEvent = async (email, subject) => {
  console.log('in record email file')
  const params = {
    TableName: 'EmailRecords',
    Item: {
      id: uuidv4(),
      email: email,
      subject: subject,
      timestamp: Date.now(),
    },
  };
  return dynamoDB.put(params).promise();
};

exports.handler = async (event) => {

let parsedMessage;
try {
  
  console.log("Raw event:", event);
  console.log("Received event:", JSON.stringify(event, null, 2));
  console.log('Looging service account')
  console.log(process.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY) 
  console.log('decoded service account')
  console.log(decodedPrivateKey) 
  console.log(parsedObject.private_key) 
  console.log(parsedObject.client_email)
  //const message  = event.Records[0].Sns.Message;
  const snsEvent = JSON.parse(event.Records[0].Sns.Message);
  const submissionUrl = snsEvent.submission_url;
  const userEmail = snsEvent.user_email;
} catch (e) {
  console.error("Error parsing SNS message:", e);
  // Handle the error appropriately
}
  
  // const fileUrl = "https://github.com/tparikh/myrepo/archive/refs/tags/v1.0.0.zip";
  const fileUrl = submissionUrl
//   const recipientEmail = message.recipientEmail; // Recipient's email address
  const recipientEmail = 'raval.as@northeastern.edu'; 
  //const recipientEmail = userEmail

  try {
    
    //const releaseUrl = 'https://github.com/tparikh/myrepo/archive/refs/tags/v1.0.0.zip';
    const releaseUrl = submissionUrl;
    const tempFilePath = '/tmp/release.zip';

    const writer = fs.createWriteStream(tempFilePath);
    const response = await axios.get(releaseUrl, { responseType: 'stream' });

    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('Release downloaded successfully.');

    const fileName = 'Test.zip'; // Destination file name in GCS
    try{
    await storage.bucket(bucketName).upload(tempFilePath, {
      destination: fileName,
    });
     }
     catch(error){
      console.error(error);
     }
    const gcsFilePath = `https://console.cloud.google.com/storage/browser/${bucketName}/${fileName}`;
    console.log(gcsFilePath)
    console.log('Release uploaded to Google Cloud Storage.');

    // Send email notification
    const emailSubject = 'Download Complete';
    const emailBody = `Your file has been downloaded and uploaded to: ${gcsFilePath}`;
    await sendEmail(recipientEmail, emailSubject, emailBody);
    console.log('Sending email Done')

    // Record the email event in DynamoDB
    const emailData = {
      Id: uuidv4(),
      email: recipientEmail,
      status: 'Sent',
      GCP_Link: gcsFilePath,
      timestamp: new Date().toISOString(),
    };

    const params = {
      TableName: process.env.DYNAMO_DB,
      Item: emailData,
    };
    
    await dynamoDB.put(params).promise();

    return { statusCode: 200, body: 'Success' };
  } catch (error) {
    console.error(error);

    // Send email notification about the failure
    await sendEmail(recipientEmail, 'Download Failed', `An error occurred while processing your file. ${error}`);

    // Record the failed email event in DynamoDB
    await recordEmailEvent(recipientEmail, 'Download Failed');

    return { statusCode: 500, body: 'Error' };
  }
};
