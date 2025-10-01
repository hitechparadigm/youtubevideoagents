# YouTube Video Agents

An automated YouTube video generation system that creates finance-focused educational content using AI agents and AWS cloud infrastructure. The project implements a complete pipeline from script generation to final video production.

## 🎯 Overview

This system creates a "YouTube content factory" that automatically generates educational finance videos from topic inputs, handling the entire production pipeline from ideation to final video output. It targets retail investors across multiple English-speaking markets with evidence-based, non-advisory content.

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Script Gen    │───▶│   TTS Engine    │───▶│  Video Render   │
│  (Bedrock AI)   │    │   (Polly)       │    │   (FFmpeg)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   S3 Storage    │    │   DynamoDB      │    │   Final Video   │
│  (Scripts/Media)│    │  (Job Tracking) │    │   (S3/YouTube)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🚀 Features

### AI-Powered Content Creation Pipeline
- **Script Generation**: Uses AWS Bedrock (Claude 3.5 Sonnet) to generate finance-focused YouTube scripts
- **Text-to-Speech**: Converts scripts to audio using Amazon Polly with intelligent chunking
- **Video Rendering**: Combines audio with B-roll footage using EDL (Edit Decision List) format
- **Multi-Region Support**: Targets audiences in US, Canada, UK, EU, Australia, and New Zealand

### Content Specifications
- **Duration**: 60-220 second videos optimized for engagement
- **Tone**: Evidence-based, professional, non-advisory with risk disclaimers
- **Audience**: Retail investors across English-speaking markets
- **Structure**: Hook → Key Points → Risk Disclaimer → Call-to-Action

## 🛠️ Technology Stack

### Backend Services
- **Python 3.12** - Core application logic
- **AWS Lambda** - Serverless compute for pipeline stages
- **AWS Bedrock** - AI script generation (Claude 3.5 Sonnet)
- **Amazon Polly** - Neural text-to-speech synthesis
- **AWS Step Functions** - Workflow orchestration

### Infrastructure
- **AWS CDK** - Infrastructure as Code (TypeScript)
- **Amazon S3** - Media storage and distribution
- **Amazon DynamoDB** - Job tracking and state management
- **AWS Secrets Manager** - API key management
- **Docker** - Containerized rendering environment

### Media Processing
- **FFmpeg** - Video rendering and composition
- **WAV/PCM Audio** - High-quality audio processing
- **MP4 Output** - Optimized video delivery format

### External Integrations
- **YouTube API** - Video upload and management
- **Pexels API** - Stock footage and B-roll content
- **ElevenLabs** - Alternative TTS option

## 📁 Project Structure

```
youtubevideoagents/
├── services/
│   └── app.py              # Lambda handlers (script, TTS, B-roll, upload)
├── renderer/
│   ├── render.py           # Video rendering engine
│   ├── Dockerfile          # Container configuration
│   └── requirements.txt    # Python dependencies
├── prompts/
│   └── script.prompt.txt   # AI prompt templates
├── infra/
│   ├── lib/
│   │   ├── core-stack.ts   # S3, DynamoDB, Secrets
│   │   ├── compute-stack.ts # Lambda functions
│   │   ├── workflow-stack.ts # Step Functions
│   │   └── identity-stack.ts # IAM roles and policies
│   ├── package.json        # CDK dependencies
│   └── cdk.json           # CDK configuration
└── history.json           # Execution logs
```

## 🔧 Setup & Deployment

### Prerequisites
- AWS CLI configured with appropriate permissions
- Node.js 18+ for CDK
- Python 3.12+ for services
- Docker for rendering container

### Infrastructure Deployment
```bash
cd infra
npm install
npm run build
npm run deploy
```

### Environment Variables
```bash
MEDIA_BUCKET=your-media-bucket
JOBS_TABLE=your-jobs-table
AWS_REGION=us-east-1
TTS_VOICE=Matthew
TTS_ENGINE=neural
TTS_SAMPLE_RATE=16000
```

### Required AWS Permissions
- Bedrock model access (Claude 3.5 Sonnet)
- Polly synthesis permissions
- S3 read/write access
- DynamoDB table operations
- Secrets Manager access

## 🎬 Pipeline Workflow

1. **Script Generation**
   - Input: Topic string
   - Process: Bedrock AI generates structured script
   - Output: `script.txt` in S3

2. **Text-to-Speech**
   - Input: Generated script
   - Process: Polly synthesis with chunking
   - Output: `voice.wav` in S3

3. **B-roll Composition**
   - Input: Job parameters
   - Process: Generate EDL for video clips
   - Output: `edl.json` in S3

4. **Video Rendering**
   - Input: Audio + EDL + B-roll footage
   - Process: FFmpeg composition
   - Output: `final.mp4` in S3

5. **Upload & Distribution**
   - Input: Final video
   - Process: YouTube API upload
   - Output: Published video

## 📊 Content Examples

### Supported Topics
- Investment strategies (REITs, ETFs, bonds)
- Market analysis and trends
- Tax implications across jurisdictions
- Risk management for retail investors
- Financial planning fundamentals

### Sample Input
```json
{
  "jobId": "demo-0001",
  "topic": "Investments in REITs for 2025: risks, yields, tax treatment (US/CA/UK/EU/AU/NZ)"
}
```

## 🔍 Monitoring & Debugging

### Job Tracking
- DynamoDB stores job status and metadata
- Step Functions provides execution visibility
- CloudWatch logs capture detailed processing info

### Common Issues
- **Bedrock Access**: Ensure IAM permissions for model invocation
- **Polly Limits**: Text chunking handles 3000+ character scripts
- **FFmpeg Errors**: Check video format compatibility

## 🚧 Current Status

The project is in active development with a functional pipeline. Recent execution logs show some AWS permissions issues that need resolution, particularly around Bedrock model access.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with sample content
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## ⚠️ Disclaimer

This system generates educational content only. All generated videos include appropriate risk disclaimers and do not constitute financial advice.