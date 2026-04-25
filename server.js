const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

function generateKlingToken() {
  const payload = {
    iss: KLING_ACCESS_KEY,
    exp: Math.floor(Date.now() / 1000) + 1800,
    nbf: Math.floor(Date.now() / 1000) - 5
  };
  return jwt.sign(payload, KLING_SECRET_KEY, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function submitKlingJobWithRetry(imageBase64, prompt, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = generateKlingToken();
      const response = await axios.post(
        'https://api.klingai.com/v1/videos/image2video',
        {
          model_name: 'kling-v1',
          image: imageBase64,
          prompt: prompt,
          duration: '5',
          mode: 'std',
          cfg_scale: 0.5
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.data.task_id;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const wait = Math.pow(2, attempt + 2) * 1000 + Math.random() * 1000;
        console.log(`Rate limited. Waiting ${Math.round(wait/1000)}s before retry ${attempt + 1}/${retries}`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries exceeded for Kling submission');
}

async function pollKlingJob(taskId) {
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const token = generateKlingToken();
    const response = await axios.get(
      `https://api.klingai.com/v1/videos/image2video/${taskId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const status = response.data.data.task_status;
    console.log(`Task ${taskId} status: ${status}`);
    if (status === 'succeed') return response.data.data.task_result.videos[0].url;
    if (status === 'failed') throw new Error('Kling generation failed');
  }
  throw new Error('Kling timed out');
}

async function downloadFile(url, destPath) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, response.data);
}

app.get('/', (
