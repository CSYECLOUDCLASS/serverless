import AWS from "aws-sdk";
import axios from "axios";
import mailgun from "mailgun-js";
import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";

dotenv.config();

AWS.config.update({
  region: 'us-east-1', 
  
});
const docClient = new AWS.DynamoDB.DocumentClient();

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
  console.log("this is the google access key", process.env.GOOGLE_ACCESS_KEY)
  const googleCredentials = JSON.parse(process.env.GOOGLE_ACCESS_KEY);
  const storage = new Storage({ credentials: googleCredentials });
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);

  return new Promise((resolve, reject) => {
    const stream = file.createWriteStream({
      metadata: {
        contentType: 'text/html',
      },
    });

    stream.on("error", (err) => reject(err));
    stream.on("finish", () => resolve("URL saved to GCS"));

    stream.end(url);
  });
}

async function saveEmailSent(emailId, emailDetails) {
  const params = {
    TableName: 'EmailsSent', 
    Item: {
      emailId: emailId, 
      emailDetails: emailDetails, 
      sentAt: new Date().toISOString()
    }
  };

  try {
    await docClient.put(params).promise();
    console.log('Email record saved:', emailId);
  } catch (error) {
    console.error('Error saving email record:', error);
  }
}

export async function handler(event, context) {
  const snsMes = event.Records[0].Sns.Message;
  const messageData = JSON.parse(snsMes);
  const mail = messageData.Mail;
  const url = messageData.http;
  const emailBody = `You can find the file here /${mail + new Date()}`;
  const mg = mailgun({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.Domain_Name,
  });

  await mg.messages().send({
    from: "help@pushkarpatil.com",
    to: mail,
    subject: "Posted Submission",
    text: emailBody,
  });
  await saveEmailSent(mail, { url: url, dateSent: new Date().toISOString() });
  console.log("Email sent successfully");

  try {
    const isValid = await isValidZipUrl(url);
    if (isValid) {
      console.log("The URL points to a ZIP file.");
      const fileName = url.split('/').pop(); // Extracts file name from URL
      await saveUrlToGCS(url, process.env.BUCKET_NAME, fileName + new Date());
      console.log("URL saved successfully");
    } else {
      console.log("The URL does not point to a ZIP file.");
    }

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
