const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
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

async function submitKlingJob(imageBase64, prompt) {
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
}

async function pollKlingJob(taskId) {
  const token = generateKlingToken();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const response = await axios.get(
      `https://api.klingai.com/v1/videos/image2video/${taskId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const status = response.data.data.task_status;
    console.log(`Task ${taskId} status: ${status}`);
    if (status === 'succeed') {
      return response.data.data.task_result.videos[0].url;
    }
    if (status === 'failed') throw new Error('Kling generation failed');
  }
  throw new Error('Kling timed out');
}

async function downloadFile(url, destPath) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, response.data);
}

app.get('/', (req, res) => res.json({ status: 'Landscaping video server running' }));

app.post('/process', async (req, res) => {
  const { job_id, project_name, clips } = req.body;
  console.log(`[${job_id}] Starting job: ${project_name}`);

  const workDir = `/tmp/job_${job_id}`;
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Step 1 — Submit all photos to Kling
    console.log(`[${job_id}] Submitting ${clips.length} clips to Kling...`);
    const taskIds = [];
    for (const clip of clips) {
      const taskId = await submitKlingJob(clip.image_base64, clip.kling_prompt);
      taskIds.push(taskId);
      console.log(`[${job_id}] Submitted: ${clip.label} → task ${taskId}`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2 — Poll all Kling jobs until complete
    console.log(`[${job_id}] Waiting for Kling to finish...`);
    const videoUrls = [];
    for (const taskId of taskIds) {
      const url = await pollKlingJob(taskId);
      videoUrls.push(url);
      console.log(`[${job_id}] Clip ready: ${url}`);
    }

    // Step 3 — Download all generated clips
    const clipPaths = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const clipPath = `${workDir}/clip_${i}.mp4`;
      await downloadFile(videoUrls[i], clipPath);
      clipPaths.push(clipPath);
      console.log(`[${job_id}] Downloaded clip ${i}`);
    }

    // Step 4 — Build FFmpeg concat list
    const concatList = clipPaths.map(p => `file '${p}'`).join('\n');
    const concatFile = `${workDir}/concat.txt`;
    fs.writeFileSync(concatFile, concatList);

    // Step 5 — Run FFmpeg to stitch + add text overlays
    const outputPath = `${workDir}/final_output.mp4`;
    const hook = req.body.hook_text || 'Your backyard deserves this.';
    const cta = req.body.cta_text || 'Book your free consultation. Link in bio.';

    const ffmpegCmd = [
      'ffmpeg -y',
      `-f concat -safe 0 -i "${concatFile}"`,
      `-vf "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,`,
      `drawtext=text='${hook}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=(h/6):enable='between(t,0,3)':box=1:boxcolor=black@0.45:boxborderw=12,`,
      `drawtext=text='BEFORE':fontcolor=white:fontsize=44:x=40:y=h-80:enable='between(t,0,${clips.filter(c=>c.type==='before').length * 5})':box=1:boxcolor=black@0.4:boxborderw=10,`,
      `drawtext=text='AFTER':fontcolor=white:fontsize=44:x=40:y=h-80:enable='between(t,${clips.filter(c=>c.type==='before').length * 5},${clips.length * 5})':box=1:boxcolor=black@0.4:boxborderw=10,`,
      `drawtext=text='${cta}':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=h-100:enable='between(t,${(clips.length * 5) - 4},${clips.length * 5})':box=1:boxcolor=black@0.5:boxborderw=12"`,
      `-c:v libx264 -b:v 6000k -preset slow -r 30`,
      `-c:a aac`,
      `"${outputPath}"`
    ].join(' ');

    console.log(`[${job_id}] Running FFmpeg...`);
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { timeout: 600000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr));
        else resolve();
      });
    });

    // Step 6 — Read and return the final video
    const videoData = fs.readFileSync(outputPath);
    const base64Video = videoData.toString('base64');

    fs.rmSync(workDir, { recursive: true, force: true });

    console.log(`[${job_id}] Complete!`);
    res.json({
      success: true,
      job_id,
      filename: `${project_name.replace(/\s+/g, '_')}_ad.mp4`,
      video_base64: base64Video
    });

  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.error(`[${job_id}] Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log('Server ready on port 3000'));
