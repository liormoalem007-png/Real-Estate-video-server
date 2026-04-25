const express = require('express');
const axios = require('axios');
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

const FAL_KEY = process.env.FAL_KEY;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function generateKlingClip(imageBase64, prompt) {
  console.log('Submitting to fal.ai Kling 3.0...');
  
  // Submit the job
  const submitRes = await axios.post(
    'https://queue.fal.run/fal-ai/kling-video/v1/standard/image-to-video',
    {
      image_url: `data:image/jpeg;base64,${imageBase64}`,
      prompt: prompt,
      duration: '5',
      aspect_ratio: '1:1'
    },
    {
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const requestId = submitRes.data.request_id;
  console.log(`Job submitted: ${requestId}`);

  // Poll for completion
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const statusRes = await axios.get(
      `https://queue.fal.run/fal-ai/kling-video/v1/standard/image-to-video/requests/${requestId}/status`,
      {
        headers: { 'Authorization': `Key ${FAL_KEY}` }
      }
    );
    
    const status = statusRes.data.status;
    console.log(`Status: ${status}`);
    
    if (status === 'COMPLETED') {
      const resultRes = await axios.get(
        `https://queue.fal.run/fal-ai/kling-video/v1/standard/image-to-video/requests/${requestId}`,
        {
          headers: { 'Authorization': `Key ${FAL_KEY}` }
        }
      );
      return resultRes.data.video.url;
    }
    
    if (status === 'FAILED') throw new Error('fal.ai generation failed');
  }
  throw new Error('fal.ai timed out');
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
    // Generate all clips with fal.ai one at a time
    console.log(`[${job_id}] Generating ${clips.length} clips with Kling 3.0...`);
    const videoUrls = [];
    
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      console.log(`[${job_id}] Clip ${i + 1}/${clips.length}: ${clip.label}`);
      const url = await generateKlingClip(clip.image_base64, clip.kling_prompt);
      videoUrls.push(url);
      console.log(`[${job_id}] Clip ${i + 1} ready: ${url}`);
      if (i < clips.length - 1) await sleep(3000);
    }

    // Download all clips
    const clipPaths = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const clipPath = `${workDir}/clip_${i}.mp4`;
      await downloadFile(videoUrls[i], clipPath);
      clipPaths.push(clipPath);
      console.log(`[${job_id}] Downloaded clip ${i + 1}`);
    }

    // FFmpeg stitch
    const concatList = clipPaths.map(p => `file '${p}'`).join('\n');
    const concatFile = `${workDir}/concat.txt`;
    fs.writeFileSync(concatFile, concatList);

    const outputPath = `${workDir}/final_output.mp4`;
    const hook = req.body.hook_text || 'Your backyard deserves this.';
    const cta = req.body.cta_text || 'Book your free consultation today. Link in bio.';

    const ffmpegCmd = [
      'ffmpeg -y',
      `-f concat -safe 0 -i "${concatFile}"`,
      `-vf "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,`,
      `drawtext=text='${hook}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=(h/6):enable='between(t,0,3)':box=1:boxcolor=black@0.45:boxborderw=12,`,
      `drawtext=text='BEFORE':fontcolor=white:fontsize=44:x=40:y=h-80:enable='between(t,0,${clips.filter(c => c.type === 'before').length * 5})':box=1:boxcolor=black@0.4:boxborderw=10,`,
      `drawtext=text='AFTER':fontcolor=white:fontsize=44:x=40:y=h-80:enable='between(t,${clips.filter(c => c.type === 'before').length * 5},${clips.length * 5})':box=1:boxcolor=black@0.4:boxborderw=10,`,
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
