import AWS from "aws-sdk";
import axios from "axios";
import mailgun from "mailgun-js";
import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";

dotenv.config();

AWS.config.update({
  region: 'us-east-1'
});

async function isValidZipUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!url.pathname.endsWith(".zip")) {
      return false;
    }
    const response = await axios.head(urlString);
    const contentType = response.headers["content-type"];
    return (
      contentType === "application/zip" ||
      contentType === "application/x-zip-compressed"
    );
  } catch (error) {
    console.error("Error validating URL:", error);
    return false;
  }
}


async function saveUrlToGCS(url, bucketName, fileName) {
  console.log("this is the google access key", process.env.GOOGLE_ACCESS_KEY);
  const googleCredentials = JSON.parse(process.env.GOOGLE_ACCESS_KEY);
  const storage = new Storage({ credentials: googleCredentials });
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);

  return new Promise((resolve, reject) => {
    const stream = file.createWriteStream({
      metadata: {
        contentType: 'application/zip',
      },
    });

    stream.on('error', (err) => reject(err));
    stream.on('finish', async () => {
      try {
        await file.makePublic();
        console.log('Upload successful and file is made public');
        resolve('URL saved to GCS and made public');
      } catch (err) {
        console.error('Error making file public:', err);
        reject(err);
      }
    });

    axios
      .get(url, { responseType: 'stream' })
      .then((response) => {
        response.data.pipe(stream);
      })
      .catch((error) => {
        console.error('Error downloading file from URL:', error);
        reject(error);
      });
  });
};

export async function handler(event, context) {
  const dynamoDB = new AWS.DynamoDB.DocumentClient();
  const snsMes = event.Records[0].Sns.Message;
  const messageData = JSON.parse(snsMes);
  const mail = messageData.Mail;
  const url = messageData.http;
  const emailSubject = "Posted Submission";
  const mg = mailgun({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.Domain_Name,
  });
  try {
    const isValid = await isValidZipUrl(url);
    let emailBody, emailDetails;

    if (isValid) {
      const date= Date.now().toString();
      console.log("The URL points to a ZIP file.");
      const fileName = url.split('/').pop();
      const file_name=fileName+date
      await saveUrlToGCS(url, process.env.BUCKET_NAME, file_name);
      console.log("URL saved successfully",file_name);
      emailBody = `Your submission is processed successfully. You can find the file here: https://storage.googleapis.com/${process.env.BUCKET_NAME}/${file_name}`;
      emailDetails = "Success, The URL points to a ZIP file.";
      console.log("Email sent successfully");
    } else {
      console.log("The URL does not point to a ZIP file.");
      emailBody = `Your submission failed. The provided URL does not point to a valid ZIP file.`;
      emailDetails = "Failed. The URL does not point to a ZIP file.";
    }

    await mg.messages().send({
      from: "help@pushkarpatil.com",
      to: mail,
      subject: emailSubject,
      text: emailBody,
    });
    

    // Update DynamoDB
    const params = {
      TableName: process.env.dynamoTableName,
      Item: {
        emailId: mail + new Date().toISOString(),
        emailDetails: emailDetails,
      },
    };
    await dynamoDB.put(params).promise();

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Lambda successful" }),
    };
  } catch (error) {
    console.error("Error in Lambda execution:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error in Lambda execution" }),
    };
  }
}
