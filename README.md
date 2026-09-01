# VidyaGuru AI

## Introduction

VidyaGuru AI is an interactive instructional platform designed to deliver engaging educational experiences using text-to-speech and animated visual models.

## Prerequisites

Before you begin, you will need to have the following installed:

### 1. Node.js
This is essential to run the project locally.
- Visit the official [Node.js website](https://nodejs.org/).
- Download the version labeled **LTS** (Long Term Support) for your operating system.
- Follow the standard installation wizard instructions.

### 2. Gemini API Key
You need an API key to allow the AI to generate responses.
- Go to [Google AI Studio](https://aistudio.google.com/apikey).
- Sign in with your Google account.
- Create a new API key.
- Copy the generated key and keep it secure.

## Installation Steps

1. **Download the project files** or clone the repository to your local machine.
2. **Open your terminal** (or Command Prompt) and navigate to the project folder.
3. **Install the required dependencies** by running the following command:
   ```bash
   npm install
   ```
   This will download all the necessary packages for the project.

## Project Configuration

1. In the project folder, locate the file named `.env.example`.
2. Create a copy of this file and rename the new copy to just `.env`.
3. Open the `.env` file using any text editor (like Notepad or VS Code).
4. Find the line that says `GEMINI_API_KEY=` and paste your API key right after the `=` sign. It should look like this:
   ```env
   GEMINI_API_KEY=AIzaSy...YourKeyHere...
   ```
5. Save and close the file.

## How to Run the Project

1. Open your terminal and navigate to the project folder.
2. After the installation is complete, use this command to start the project:
   ```bash
   npm run dev
   ```
3. Wait for the server to spin up. You will see a local URL in the terminal, usually `http://localhost:3000`.
4. Open your web browser and go to that URL to start using **VidyaGuru AI**.

## Optional: Free AI Lip-Sync Video Avatar

By default, VidyaGuru AI uses an animated avatar with free neural text-to-speech.
If you want a real lip-synced video avatar instead, see `WAV2LIP_SETUP.md` for the
full setup guide. It's optional, free, and runs entirely on your own machine.

## Known Limitations

- **Multi-language Support:** Hindi, English, and Spanish are fully supported. The text-to-speech engine has limited compatibility with Assamese.
- **Visual Models:** An animated avatar model is used by default in place of a dynamic AI video avatar, due to the setup/hardware requirements of true lip-sync video generation. See the optional Wav2Lip setup above if you want the full video avatar experience.
- **RAG:** Retrieval from uploaded material uses keyword-based matching rather than vector embeddings, so accuracy may vary on very large documents.
- **Storage:** Learning progress is saved locally in the browser and does not sync across devices.
