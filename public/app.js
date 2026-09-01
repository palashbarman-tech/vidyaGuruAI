const MODEL = "gemini-3.5-flash";
let state = {
  screen: "setup",
  material: { fileName: null, chunks: [] },
  profile: { level: "beginner", language: "English", time: "20", style: "simple, friendly, with real-world examples", videoMode: false },
  topicOrInstruction: "",
  lessonPlan: null,
  segIndex: 0,
  answers: [],
  quiz: null,
  quizAnswers: [],
  report: null,
  voices: [],
  muted: localStorage.getItem("vidyaguru:muted") === "true",
};

const LANG_SCRIPT_HINT = {
  Hindi: "Hindi language, written in Devanagari script (हिन्दी) — never in Roman/Latin transliteration.",
  English: "English language.",
  Hinglish: "Hinglish — a natural mix of Hindi and English, written in Roman/Latin script (not Devanagari).",
  Assamese: "Assamese language, written in the Assamese (Asomiya) script (অসমীয়া) with its distinct ৰ and ৱ letters — never in Hindi, Devanagari, English, or standard Bengali script instead.",
  Bengali: "Bengali language, written in Bengali script (বাংলা).",
  Tamil: "Tamil language, written in Tamil script (தமிழ்).",
  Spanish: "Spanish language, written in standard Spanish.",
};
function langInstruction(lang){
  return LANG_SCRIPT_HINT[lang] || lang;
}

async function askClaude(systemPrompt, userPrompt, wantJSON=true){
  const res = await fetch("/api/teach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      wantJSON: wantJSON
    })
  });
  if(!res.ok){
    const errText = await res.text();
    throw new Error("Server error: " + errText);
  }
  const data = await res.json();
  let text = (data.content || []).map(b => b.text || "").join("\n");
  if(wantJSON){
    text = text.replace(/```json/g,"").replace(/```/g,"").trim();
    try{ return JSON.parse(text); }
    catch(e){
      const m = text.match(/\{[\s\S]*\}/);
      if(m){ try{ return JSON.parse(m[0]); }catch(e2){} }
      console.error("JSON parse failed. Raw response was:", text);
      throw new Error("Couldn't parse teacher response (likely got cut off). Try again — this should be much rarer now.");
    }
  }
  return text;
}

async function extractText(file){
  const ext = file.name.split('.').pop().toLowerCase();
  if(ext === "pdf"){
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: buf}).promise;
    let full = "";
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      full += content.items.map(it=>it.str).join(" ") + "\n\n";
    }
    return full;
  } else if(ext === "docx"){
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({arrayBuffer: buf});
    return result.value;
  } else if(ext === "pptx"){
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/parse-pptx", { method: "POST", body: form });
    if(!res.ok){
      const err = await res.json().catch(()=>({error:"unknown error"}));
      throw new Error(err.error || "Could not read that PPTX file");
    }
    const data = await res.json();
    return data.text;
  } else {
    return await file.text();
  }
}

function chunkText(text, size=900, overlap=150){
  const clean = text.replace(/\s+/g," ").trim();
  const chunks = [];
  let i=0, id=0;
  while(i < clean.length){
    chunks.push({ id: id++, text: clean.slice(i, i+size) });
    i += (size - overlap);
  }
  return chunks;
}

function retrieve(query, chunks, k=5){
  const terms = query.toLowerCase().match(/[a-z0-9\u0900-\u097F]+/g) || [];
  const scored = chunks.map(c=>{
    const lc = c.text.toLowerCase();
    let score = 0;
    terms.forEach(t=>{ if(t.length>2 && lc.includes(t)) score++; });
    return {...c, score};
  });
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,k).filter(c=>c.score>0).length ? scored.slice(0,k) : chunks.slice(0,k);
}

const LOADING_ICONS = ["🧠","📚","✨","🎨","🚀","🔍"];
const STAGE_MAP = {
  planning: "lesson", lesson: "lesson", grading_seg: "lesson",
  quiz_gen: "quiz", quiz: "quiz",
  report_gen: "grade", report: "grade",
};
const STAGES = [
  { key: "lesson", label: "📖 Lesson" },
  { key: "quiz", label: "📝 Quiz" },
  { key: "grade", label: "🏆 Grade" },
];
function renderStageTabs(){
  const tabsEl = document.getElementById("stageTabs");
  if(!tabsEl) return;
  const activeStage = STAGE_MAP[state.screen];
  if(!activeStage){ tabsEl.innerHTML = ""; return; }
  const order = STAGES.map(s=>s.key);
  const activeIdx = order.indexOf(activeStage);
  tabsEl.innerHTML = `<div class="stage-tabs">
    ${STAGES.map((s,i)=>{
      const state_ = i < activeIdx ? "done" : (i === activeIdx ? "active" : "upcoming");
      return `<div class="stage-tab ${state_}"><span class="stage-tab-dot"></span>${s.label}</div>`;
    }).join(`<div class="stage-tab-line"></div>`)}
  </div>`;
}
function render(){
  const board = document.getElementById("board");
  board.classList.remove("screen-enter");
  if(state.screen === "setup") board.innerHTML = renderSetup();
  else if(state.screen === "planning") board.innerHTML = renderLoading("Planning your lesson...");
  else if(state.screen === "lesson") board.innerHTML = renderLesson();
  else if(state.screen === "grading_seg") board.innerHTML = renderLoading("Checking your answer...");
  else if(state.screen === "quiz_gen") board.innerHTML = renderLoading("Preparing your final quiz...");
  else if(state.screen === "quiz") board.innerHTML = renderQuiz();
  else if(state.screen === "report_gen") board.innerHTML = renderLoading("Building your learning report...");
  else if(state.screen === "report") board.innerHTML = renderReport();
  renderStageTabs();
  void board.offsetWidth;
  board.classList.add("screen-enter");
  attachHandlers();
  if(state.screen === "report") celebrateReport();
}
function renderLoading(msg){
  const icon = LOADING_ICONS[Math.floor(Math.random()*LOADING_ICONS.length)];
  return `<div class="loading"><div class="spinner-fun">${icon}</div><div class="loadtext">${msg}</div></div>`;
}

function confettiBurst(count=60){
  const colors = ["#FF3D9A","#FFD23F","#2FE6E0","#3FE08C","#A78BFA","#FF8A3D"];
  for(let i=0;i<count;i++){
    const el = document.createElement("div");
    el.className = "confetti-piece";
    const size = 6 + Math.random()*8;
    el.style.width = size+"px";
    el.style.height = (size*0.4 + 4)+"px";
    el.style.left = Math.random()*100+"vw";
    el.style.background = colors[Math.floor(Math.random()*colors.length)];
    el.style.animationDuration = (2.2 + Math.random()*1.8)+"s";
    el.style.animationDelay = (Math.random()*0.4)+"s";
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 4500);
  }
}
function emojiBurst(emojis, x, y, count=8){
  for(let i=0;i<count;i++){
    const el = document.createElement("div");
    el.className = "emoji-burst";
    el.textContent = emojis[Math.floor(Math.random()*emojis.length)];
    el.style.left = (x + (Math.random()*80-40)) + "px";
    el.style.top = (y + (Math.random()*20-10)) + "px";
    el.style.animationDelay = (Math.random()*0.2)+"s";
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 1500);
  }
}
function emojiBurstFromEvent(evt, emojis){
  const r = evt.target.getBoundingClientRect();
  emojiBurst(emojis, r.left + r.width/2, r.top, 6);
}
function celebrateReport(){
  confettiBurst(80);
  setTimeout(()=>confettiBurst(40), 400);
}
function addRipple(evt){
  const btn = evt.currentTarget;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = ripple.style.height = size+"px";
  ripple.style.left = (evt.clientX - rect.left - size/2)+"px";
  ripple.style.top = (evt.clientY - rect.top - size/2)+"px";
  btn.style.position = btn.style.position || "relative";
  btn.appendChild(ripple);
  setTimeout(()=>ripple.remove(), 600);
}
function zoomAdvance(callback){
  const board = document.getElementById("board");
  board.classList.remove("screen-enter");
  board.classList.add("screen-zoom-out");
  setTimeout(()=>{ board.classList.remove("screen-zoom-out"); callback(); }, 340);
}

function renderSetup(){
  return `
  <h2 class="step-title">Start a lesson</h2>
  <p class="sub">Upload material, or just tell VidyaguruAI what you want to learn.</p>

  <label>Upload material (optional) — PDF, DOCX, PPTX or TXT</label>
  <div class="dropzone ${state.material.fileName?'filled':''}" id="dropzone">
    ${state.material.fileName ? `📄 ${state.material.fileName} — click to replace` : "Click to choose a file, or drag it here"}
  </div>
  <input type="file" id="fileInput" accept=".pdf,.docx,.pptx,.txt" style="display:none" />

  <label>Topic or instruction</label>
  <textarea id="topicInput" rows="3" placeholder="e.g. 'Teach me Chapter 4 in 20 minutes, explain in Hindi with simple examples' or 'Teach me Newton's Laws from the beginning'">${state.topicOrInstruction}</textarea>

  <div class="row">
    <div>
      <label>Level</label>
      <select id="levelSel">
        <option value="beginner" ${state.profile.level==='beginner'?'selected':''}>Beginner</option>
        <option value="intermediate" ${state.profile.level==='intermediate'?'selected':''}>Intermediate</option>
        <option value="advanced" ${state.profile.level==='advanced'?'selected':''}>Advanced</option>
      </select>
    </div>
    <div>
      <label>Language</label>
      <select id="langSel">
        <option ${state.profile.language==='English'?'selected':''}>English</option>
        <option ${state.profile.language==='Hindi'?'selected':''}>Hindi</option>
        <option ${state.profile.language==='Hinglish'?'selected':''}>Hinglish</option>
        <option ${state.profile.language==='Assamese'?'selected':''}>Assamese</option>
        <option ${state.profile.language==='Bengali'?'selected':''}>Bengali</option>
        <option ${state.profile.language==='Tamil'?'selected':''}>Tamil</option>
        <option ${state.profile.language==='Spanish'?'selected':''}>Spanish</option>
      </select>
    </div>
    <div>
      <label>Time available</label>
      <select id="timeSel">
        <option value="5" ${state.profile.time==='5'?'selected':''}>5 minutes</option>
        <option value="20" ${state.profile.time==='20'?'selected':''}>20 minutes</option>
        <option value="60" ${state.profile.time==='60'?'selected':''}>60 minutes</option>
      </select>
    </div>
  </div>
  <label style="display:flex; align-items:center; gap:10px; cursor:pointer; margin-top:18px;">
    <input type="checkbox" id="videoModeChk" ${state.profile.videoMode?'checked':''} style="width:18px;height:18px;accent-color:var(--pink);" />
    <span style="text-transform:none; letter-spacing:normal; color:var(--text); font-weight:500; font-size:14px;">🎥 Use AI lip-sync video avatar (experimental — needs local Wav2Lip service running, see WAV2LIP_SETUP.md)</span>
  </label>
  <p class="hint">🔊 Voice uses a free neural text-to-speech engine — Hindi/Bengali/Tamil sound natural. Assamese has limited voice support anywhere; if unavailable, VidyaguruAI falls back to the closest voice and still shows full text.</p>
  <div class="actions">
    <button class="btn" id="startBtn">Start lesson →</button>
  </div>`;
}

function renderLesson(){
  const plan = state.lessonPlan;
  const seg = plan.segments[state.segIndex];
  const pct = Math.round(((state.segIndex) / plan.segments.length) * 100);
  const lastAnswer = state.answers[state.segIndex];

  let questionHtml = "";
  if(seg.question){
    if(lastAnswer){
      questionHtml = `<div class="qbox">
        <div class="qlabel">Question</div>
        <div>${seg.question.prompt}</div>
        <div class="feedback ${lastAnswer.correct?'good':'bad'}">${lastAnswer.feedback}</div>
      </div>`;
    } else if(seg.question.type === "mcq"){
      questionHtml = `<div class="qbox">
        <div class="qlabel">Quick check</div>
        <div>${seg.question.prompt}</div>
        ${seg.question.options.map((o,i)=>`<button class="mcq-opt" data-idx="${i}">${o}</button>`).join("")}
      </div>`;
    } else {
      questionHtml = `<div class="qbox">
        <div class="qlabel">Quick check</div>
        <div>${seg.question.prompt}</div>
        <textarea id="freeAnswer" rows="2" style="margin-top:10px;" placeholder="Type your answer..."></textarea>
        <div class="actions" style="margin-top:10px;"><button class="btn" id="submitFree">Submit answer</button></div>
      </div>`;
    }
  }

  const canAdvance = !seg.question || !!lastAnswer;

  return `
  <div class="stage">
    <div class="avatar-col">
      <div class="avatar-wrap" id="avatarWrap">
        ${state.profile.videoMode ? `<video id="videoAvatar" width="140" height="140" style="border-radius:50%; object-fit:cover; background:#000;" playsinline></video>` : avatarSVG()}
        <div class="small" style="margin-top:8px;">${state.speaking?'🗣️ speaking…':'😊 ready'}</div>
        <button class="btn secondary" id="replayBtn" style="margin-top:10px;width:100%;">🔊 Replay</button>
      </div>
      <div id="voiceNotice" class="voice-notice" style="display:none;"></div>
    </div>
    <div class="progress-col">
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="small" style="margin-bottom:10px;">${plan.title} — step ${state.segIndex+1} of ${plan.segments.length}</div>
      <h2 class="segment-title">${seg.title}</h2>
      <div class="segment-text">${seg.explanation}</div>
      ${seg.visual ? `<div class="visual-box">${renderVisual(seg.visual)}</div>` : ""}
      ${questionHtml}
      <div class="actions">
        ${state.segIndex>0 ? `<button class="btn secondary" id="backBtn">← Back</button>` : ""}
        <button class="btn" id="nextBtn" ${canAdvance?"":"disabled"}>
          ${state.segIndex === plan.segments.length-1 ? "Finish → Final Quiz" : "Continue →"}
        </button>
      </div>
    </div>
  </div>`;
}

function renderVisual(v){
  if(v.type === "code"){
    return `<div style="font-family:var(--font-mono); font-size:13px; white-space:pre-wrap; color:#B7E3C4;">${escapeHtml(v.content)}</div>`;
  }
  if(v.type === "formula"){
    return `<div style="font-family:var(--font-display); font-size:19px; text-align:center; color:var(--amber);">${escapeHtml(v.content)}</div>`;
  }
  if(v.type === "timeline"){
    const items = v.items || [];
    return `<div style="display:flex; flex-direction:column; gap:6px;">
      ${items.map(it=>`<div style="display:flex; gap:10px;"><div style="color:var(--amber); font-weight:700; min-width:70px;">${it.label}</div><div>${it.detail}</div></div>`).join("")}
    </div>`;
  }
  if(v.type === "diagram_steps"){
    const items = v.items || [];
    return `<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
      ${items.map((it,i)=>`<div style="background:rgba(0,0,0,0.2); border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:13.5px;">${it}</div>${i<items.length-1?'<span style="color:var(--amber);">→</span>':''}`).join("")}
    </div>`;
  }
  return `<div>${escapeHtml(v.content||"")}</div>`;
}

function escapeHtml(s){ return (s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function renderQuiz(){
  const q = state.quiz;
  const idx = state.quizIndex || 0;
  const question = q.questions[idx];
  const answered = state.quizAnswers[idx];
  return `
  <h2 class="step-title">Final Assessment</h2>
  <p class="sub">Question ${idx+1} of ${q.questions.length}</p>
  <div class="qbox">
    <div>${question.prompt}</div>
    ${question.type==='mcq' ? question.options.map((o,i)=>{
        let cls='mcq-opt';
        if(answered){
          if(i===question.correctIndex) cls+=' correct';
          else if(i===answered.selected) cls+=' wrong';
        }
        return `<button class="${cls}" data-qidx="${i}" ${answered?'disabled':''}>${o}</button>`;
      }).join("")
      : `<textarea id="quizFree" rows="2" style="margin-top:10px;" ${answered?'disabled':''} placeholder="Type your answer...">${answered?answered.text:""}</textarea>
         ${!answered?`<div class="actions" style="margin-top:10px;"><button class="btn" id="submitQuizFree">Submit</button></div>`:""}`
    }
    ${answered ? `<div class="feedback ${answered.correct?'good':'bad'}">${answered.feedback}</div>` : ""}
  </div>
  <div class="actions">
    <button class="btn" id="quizNextBtn" ${answered?"":"disabled"}>${idx===q.questions.length-1?"See my report →":"Next →"}</button>
  </div>`;
}

function scoreCelebrationEmoji(score){
  if(score >= 80) return "🏆🎉🌟";
  if(score >= 50) return "👏✨💪";
  return "💡🌱📖";
}
function renderReport(){
  const r = state.report;
  return `
  <div class="celebrate-header">${scoreCelebrationEmoji(r.score)}</div>
  <h2 class="step-title" style="text-align:center;">Woohoo! Lesson Complete</h2>
  <div class="report" style="text-align:center;">
    <div class="score-circle"><span>${r.score}%</span></div>
    <div style="text-align:left; max-width:520px; margin:0 auto;">
      <h3>💪 Strong areas</h3>
      <div>${r.strong.map(s=>`<span class="tag strong">✅ ${s}</span>`).join("") || "<span class='small'>—</span>"}</div>
      <h3>🌱 Needs improvement</h3>
      <div>${r.weak.map(s=>`<span class="tag weak">📌 ${s}</span>`).join("") || "<span class='small'>—</span>"}</div>
      <h3>🎯 Recommendation</h3>
      <p class="segment-text">${r.recommendation}</p>
      <h3>🚀 Suggested next topic</h3>
      <p class="segment-text">${r.nextTopic}</p>
    </div>
  </div>
  <div class="controls-inline">
    <button class="btn" id="restartBtn">🔁 Start a new lesson</button>
  </div>`;
}

function avatarSVG(){
  return `<svg width="140" height="140" viewBox="0 0 140 140" id="avatarSvg">
    <circle cx="70" cy="70" r="62" fill="#2C4A38" stroke="#E8B94F" stroke-width="2"/>
    <circle cx="50" cy="60" r="6" fill="#F4EFDD" class="eye"/>
    <circle cx="90" cy="60" r="6" fill="#F4EFDD" class="eye"/>
    <path id="mouthPath" d="M 50 92 Q 70 92 90 92" stroke="#F4EFDD" stroke-width="4" fill="none" stroke-linecap="round"/>
  </svg>`;
}
let blinkInterval;
function startBlink(){
  clearInterval(blinkInterval);
  blinkInterval = setInterval(()=>{
    document.querySelectorAll('.eye').forEach(e=>e.setAttribute('ry','1'));
    document.querySelectorAll('.eye').forEach(e=>e.setAttribute('cy', e.getAttribute('cy')));
    const eyes = document.querySelectorAll('.eye');
    eyes.forEach(e=>e.style.transform='scaleY(0.1)');
    setTimeout(()=>eyes.forEach(e=>e.style.transform='scaleY(1)'), 150);
  }, 3200);
}
function mouthLoopStart(){
  const wrap = document.getElementById('avatarWrap');
  if(wrap) wrap.classList.add('speaking');
  let mouthOpen = false;
  const mouthInterval = setInterval(()=>{
    const path = document.getElementById('mouthPath');
    if(!path) return;
    mouthOpen = !mouthOpen;
    path.setAttribute('d', mouthOpen ? "M 50 90 Q 70 105 90 90" : "M 50 92 Q 70 92 90 92");
  }, 160);
  const lbl0 = document.querySelector('.avatar-col .small'); if(lbl0) lbl0.textContent = '🗣️ speaking…';
  return mouthInterval;
}
function mouthLoopStop(mouthInterval){
  clearInterval(mouthInterval); state.speaking=false;
  const p=document.getElementById('mouthPath'); if(p) p.setAttribute('d',"M 50 92 Q 70 92 90 92");
  const w=document.getElementById('avatarWrap'); if(w) w.classList.remove('speaking');
  const lbl = document.querySelector('.avatar-col .small'); if(lbl) lbl.textContent = '😊 ready';
}

let speakRequestId = 0;

function speakViaVideoAvatar(text, lang, token){
  return new Promise(async (resolve, reject)=>{
    try{
      const res = await fetch("/api/avatar-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: lang })
      });
      if(!res.ok){
        const errData = await res.json().catch(()=>({}));
        throw new Error(errData.error || "avatar-video backend unavailable");
      }
      const blob = await res.blob();
      if(token !== speakRequestId){ resolve(); return; }
      const url = URL.createObjectURL(blob);
      const videoEl = document.getElementById("videoAvatar");
      if(!videoEl) throw new Error("video element missing");
      videoEl.src = url;
      state.speaking = true;
      const wrap = document.getElementById('avatarWrap');
      if(wrap) wrap.classList.add('speaking');
      const lbl0 = document.querySelector('.avatar-col .small'); if(lbl0) lbl0.textContent = '🗣️ speaking…';
      showVoiceNotice("");
      videoEl.onended = ()=>{
        state.speaking=false;
        if(wrap) wrap.classList.remove('speaking');
        const lbl = document.querySelector('.avatar-col .small'); if(lbl) lbl.textContent = '😊 ready';
        URL.revokeObjectURL(url);
        resolve();
      };
      videoEl.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error("video playback failed")); };
      await videoEl.play();
    }catch(err){ reject(err); }
  });
}

let currentAudio = null;

function speakViaEdgeTTS(text, lang, token){
  return new Promise(async (resolve, reject)=>{
    try{
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: lang })
      });
      if(!res.ok) throw new Error("TTS backend unavailable");
      const blob = await res.blob();
      if(token !== speakRequestId){ resolve(); return; }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      state.speaking = true;
      const mouthInterval = mouthLoopStart();
      showVoiceNotice("");
      audio.onended = ()=>{ mouthLoopStop(mouthInterval); URL.revokeObjectURL(url); currentAudio = null; resolve(); };
      audio.onerror = ()=>{ mouthLoopStop(mouthInterval); URL.revokeObjectURL(url); currentAudio = null; reject(new Error("audio playback failed")); };
      await audio.play();
    }catch(err){ reject(err); }
  });
}

const LANG_CODES = {Hindi:"hi-IN", English:"en-US", Hinglish:"hi-IN", Assamese:"as-IN", Bengali:"bn-IN", Tamil:"ta-IN", Spanish:"es-ES"};
const FALLBACK_CHAIN = {"as-IN": ["bn-IN","hi-IN","en-IN","en-US"], "bn-IN": ["hi-IN","en-IN","en-US"], "hi-IN": ["en-IN","en-US"], "ta-IN": ["hi-IN","en-IN","en-US"]};
function findVoiceForLang(langCode){
  const exact = state.voices.filter(v=>v.lang.toLowerCase()===langCode.toLowerCase());
  const googleExact = exact.find(v=>/google/i.test(v.name));
  if(googleExact) return googleExact;
  if(exact.length) return exact[0];
  const prefix = langCode.split('-')[0].toLowerCase();
  const partial = state.voices.filter(v=>v.lang.toLowerCase().startsWith(prefix));
  const googlePartial = partial.find(v=>/google/i.test(v.name));
  if(googlePartial) return googlePartial;
  if(partial.length) return partial[0];
  return null;
}
function resolveVoice(langCode){
  let voice = findVoiceForLang(langCode);
  let usedLang = langCode;
  if(!voice){
    const chain = FALLBACK_CHAIN[langCode] || ["en-US"];
    for(const alt of chain){
      voice = findVoiceForLang(alt);
      if(voice){ usedLang = alt; break; }
    }
  }
  return { voice, usedLang };
}
function showVoiceNotice(msg){
  const el = document.getElementById('voiceNotice');
  if(el){ el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}
function speakViaBrowser(text, lang, token){
  return new Promise(resolve=>{
    if(!('speechSynthesis' in window)){ resolve(); return; }
    window.speechSynthesis.cancel();
    if(token !== speakRequestId){ resolve(); return; }
    const utter = new SpeechSynthesisUtterance(text);
    const requestedCode = LANG_CODES[lang] || "en-US";
    const { voice, usedLang } = resolveVoice(requestedCode);
    utter.lang = usedLang;
    if(voice) utter.voice = voice;
    if(!voice){
      showVoiceNotice(`⚠️ Free neural voice server unreachable and no ${lang} voice found on this device — reading in a fallback voice. Text is still shown below.`);
    } else {
      showVoiceNotice(`⚠️ Using your browser's built-in voice (neural voice server unreachable).`);
    }
    state.speaking = true;
    const mouthInterval = mouthLoopStart();
    utter.onend = ()=>{ mouthLoopStop(mouthInterval); resolve(); };
    utter.onerror = ()=>{ mouthLoopStop(mouthInterval); resolve(); };
    window.speechSynthesis.speak(utter);
  });
}
if('speechSynthesis' in window){
  speechSynthesis.onvoiceschanged = ()=>{ state.voices = speechSynthesis.getVoices(); };
  state.voices = speechSynthesis.getVoices();
}

function stopAllVoice(){
  speakRequestId++;
  window.speechSynthesis.cancel();
  if(currentAudio){ currentAudio.pause(); currentAudio.currentTime = 0; currentAudio = null; }
  const videoEl = document.getElementById("videoAvatar");
  if(videoEl){ videoEl.pause(); videoEl.currentTime = 0; }
  state.speaking = false;
  const wrap = document.getElementById('avatarWrap');
  if(wrap) wrap.classList.remove('speaking');
  const lbl = document.querySelector('.avatar-col .small'); if(lbl) lbl.textContent = '😊 ready';
}

function toggleMute(){
  state.muted = !state.muted;
  localStorage.setItem("vidyaguru:muted", state.muted);
  if(state.muted) stopAllVoice();
  updateMuteButton();
}
function updateMuteButton(){
  const btn = document.getElementById("muteToggleBtn");
  if(!btn) return;
  btn.textContent = state.muted ? "🔇" : "🔊";
  btn.title = state.muted ? "Unmute voice" : "Mute voice";
  btn.classList.toggle("muted", state.muted);
}

async function speak(text, lang){
  if(state.muted) return;
  const myToken = ++speakRequestId;
  if(state.profile.videoMode){
    try{
      await speakViaVideoAvatar(text, lang, myToken);
      return;
    }catch(err){
      console.warn("Wav2Lip video avatar unavailable, falling back to audio-only voice:", err.message);
      showVoiceNotice(`⚠️ AI video avatar unreachable (${err.message}). Falling back to voice-only. Check WAV2LIP_SETUP.md and make sure the Python service is running.`);
    }
  }
  try{
    await speakViaEdgeTTS(text, lang, myToken);
  }catch(err){
    console.warn("Edge TTS unavailable, falling back to browser voice:", err.message);
    await speakViaBrowser(text, lang, myToken);
  }
}

function attachHandlers(){
  if(state.screen === "setup"){
    document.getElementById("dropzone").onclick = ()=>document.getElementById("fileInput").click();
    document.getElementById("fileInput").onchange = async (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      state.material.fileName = file.name;
      render();
      try{
        const text = await extractText(file);
        state.material.chunks = chunkText(text);
      }catch(err){
        alert("Couldn't read that file: " + err.message);
        state.material.fileName = null;
      }
      render();
    };
    document.getElementById("startBtn").onclick = startLesson;
  }
  if(state.screen === "lesson"){
    startBlink();
    const seg = state.lessonPlan.segments[state.segIndex];
    if(!state.narrated){
      state.narrated = true;
      speak(seg.explanation.replace(/[*_#]/g,''), state.profile.language);
    }
    const replay = document.getElementById("replayBtn");
    if(replay) replay.onclick = ()=>{ stopAllVoice(); speak(seg.explanation.replace(/[*_#]/g,''), state.profile.language); };
    const nextBtn = document.getElementById("nextBtn");
    if(nextBtn) nextBtn.onclick = advanceSegment;
    const backBtn = document.getElementById("backBtn");
    if(backBtn) backBtn.onclick = ()=>{ stopAllVoice(); state.segIndex--; state.narrated=false; render(); };
    document.querySelectorAll(".mcq-opt").forEach(btn=>{
      btn.onclick = ()=>handleMcqAnswer(parseInt(btn.dataset.idx));
    });
    const submitFree = document.getElementById("submitFree");
    if(submitFree) submitFree.onclick = handleFreeAnswer;
  }
  if(state.screen === "quiz"){
    document.querySelectorAll(".mcq-opt").forEach(btn=>{
      btn.onclick = ()=>handleQuizMcq(parseInt(btn.dataset.qidx));
    });
    const sf = document.getElementById("submitQuizFree");
    if(sf) sf.onclick = handleQuizFree;
    const nb = document.getElementById("quizNextBtn");
    if(nb) nb.onclick = advanceQuiz;
  }
  if(state.screen === "report"){
    document.getElementById("restartBtn").onclick = ()=>{
      stopAllVoice();
      state = {...state, screen:"setup", segIndex:0, answers:[], quiz:null, quizAnswers:[], quizIndex:0, report:null, narrated:false, lessonPlan:null, topicOrInstruction:""};
      render();
    };
  }
}

async function startLesson(){
  state.topicOrInstruction = document.getElementById("topicInput").value.trim();
  state.profile.level = document.getElementById("levelSel").value;
  state.profile.language = document.getElementById("langSel").value;
  state.profile.time = document.getElementById("timeSel").value;
  state.profile.videoMode = document.getElementById("videoModeChk").checked;
  if(!state.topicOrInstruction && state.material.chunks.length===0){
    alert("Please enter a topic or upload material.");
    return;
  }
  zoomAdvance(()=>{ state.screen = "planning"; render(); });

  let contextBlock = "";
  if(state.material.chunks.length){
    const relevant = retrieve(state.topicOrInstruction || "overview key concepts", state.material.chunks, 6);
    contextBlock = "SOURCE MATERIAL EXCERPTS (grounded — use only these facts from the material, cite nothing external):\n" +
      relevant.map(c=>`[chunk ${c.id}] ${c.text}`).join("\n\n");
  }

  const numSegments = state.profile.time==="5" ? 2 : state.profile.time==="20" ? 4 : 6;
  const sys = `You are Guru, an expert, warm, human-like AI teacher. You design structured, personalized lessons.
Always respond with ONLY valid JSON, no markdown fences, no commentary.`;
  const user = `Build a lesson plan.
Learner profile: level=${state.profile.level}, teaching language=${state.profile.language}, time available=${state.profile.time} minutes, style=${state.profile.style || "friendly with real-world examples"}.
Learner request: "${state.topicOrInstruction || "Teach the key concepts from the uploaded material"}"
${contextBlock ? contextBlock : "No source material uploaded — teach the topic from your own knowledge, structured pedagogically."}

Requirements:
- Write ALL explanation text, visual content, and question text in ${langInstruction(state.profile.language)}. This is non-negotiable — no English mixed in unless the target language is English or Hinglish.
- Produce exactly ${numSegments} teaching segments, ordered pedagogically (simple → deeper), sized to fit ${state.profile.time} minutes total.
- Each segment has a short spoken "explanation" (3-6 sentences, ${state.profile.level}-appropriate depth, with a concrete example or analogy).
- Include a "visual" for most segments: one of type "formula" (content=short equation/text), "code" (content=short code snippet), "timeline" (items=[{label,detail}]), "diagram_steps" (items=[short strings representing a process/flow]), or omit if not useful. Pick the type appropriate to the subject.
- Include a "question" on about half the segments to check understanding: type "mcq" (options=array of 4, correctIndex) or type "short" (no options) — the question prompt and all options must be written in ${langInstruction(state.profile.language)}.
- Give the whole lesson a short "title".

Return JSON exactly in this shape:
{"title": "...", "segments": [ {"title":"...", "explanation":"...", "visual": {"type":"...", "content":"...", "items":[...]} , "question": {"type":"mcq","prompt":"...","options":["..."],"correctIndex":0} } ]}
Omit "visual" or "question" keys entirely on segments where they don't apply (don't include null).`;

  try{
    const plan = await askClaude(sys, user, true);
    state.lessonPlan = plan;
    state.segIndex = 0;
    state.answers = [];
    state.narrated = false;
    state.screen = "lesson";
  }catch(e){
    alert("Lesson planning failed: " + e.message);
    state.screen = "setup";
  }
  render();
}

async function handleMcqAnswer(idx){
  const seg = state.lessonPlan.segments[state.segIndex];
  const correct = idx === seg.question.correctIndex;
  const clickedBtn = document.querySelector(`.mcq-opt[data-idx="${idx}"]`);
  document.querySelectorAll(".mcq-opt").forEach((b,i)=>{
    if(i===seg.question.correctIndex) b.classList.add("correct");
    if(i===idx && !correct) b.classList.add("wrong");
  });
  if(clickedBtn){
    const r = clickedBtn.getBoundingClientRect();
    if(correct) emojiBurst(["🎉","✅","⭐","🙌"], r.left + r.width/2, r.top, 7);
    else emojiBurst(["🤔","💭"], r.left + r.width/2, r.top, 3);
  }
  state.screen = "grading_seg";
  const fb = await gradeAnswer(seg.question.prompt, seg.question.options[idx], correct, seg.explanation);
  state.answers[state.segIndex] = { correct, feedback: fb };
  state.screen = "lesson";
  render();
}
async function handleFreeAnswer(){
  const val = document.getElementById("freeAnswer").value.trim();
  if(!val) return;
  const seg = state.lessonPlan.segments[state.segIndex];
  state.screen = "grading_seg"; render();
  const evalRes = await evaluateFree(seg.question.prompt, val, seg.explanation);
  state.answers[state.segIndex] = { correct: evalRes.correct, feedback: evalRes.feedback };
  state.screen = "lesson";
  render();
}
async function gradeAnswer(question, chosen, correct, context){
  if(correct) return "Correct! " + (await shortEncourage(question, context));
  const sys = "You are a kind, expert tutor. Explain misconceptions briefly and re-teach in 2-3 sentences. Respond in plain text, in " + langInstruction(state.profile.language) + ".";
  const user = `Concept context: ${context}\nQuestion: ${question}\nStudent chose: "${chosen}" (incorrect).\nExplain the misconception and the correct idea clearly and kindly in 2-3 sentences.`;
  return await askClaude(sys, user, false);
}
async function shortEncourage(question, context){
  return "";
}
async function evaluateFree(question, answer, context){
  const sys = `You are a kind expert tutor evaluating a short-answer response. Respond ONLY as JSON: {"correct": true/false, "feedback": "2-3 sentence feedback in ${langInstruction(state.profile.language)}, encouraging if right, correcting the misconception if wrong"}.`;
  const user = `Context: ${context}\nQuestion: ${question}\nStudent's answer: "${answer}"\nEvaluate leniently for understanding, not exact wording.`;
  try{ return await askClaude(sys, user, true); }
  catch(e){ return {correct:true, feedback:"Good effort — let's continue."}; }
}

function advanceSegment(){
  stopAllVoice();
  zoomAdvance(()=>{
    if(state.segIndex < state.lessonPlan.segments.length - 1){
      state.segIndex++;
      state.narrated = false;
      render();
    } else {
      startQuiz();
    }
  });
}

async function startQuiz(){
  state.screen = "quiz_gen"; render();
  const sys = `You are Guru, an expert teacher building a final assessment. Respond ONLY as valid JSON.`;
  const user = `Based on this lesson titled "${state.lessonPlan.title}" with segments: ${state.lessonPlan.segments.map(s=>s.title+": "+s.explanation).join(" | ")}
Create a 4-question final quiz in ${langInstruction(state.profile.language)}, mixing 3 "mcq" (options array of 4 + correctIndex) and 1 "short" answer question, testing the concepts taught, appropriate for a ${state.profile.level} learner.
Return JSON: {"questions":[{"type":"mcq","prompt":"...","options":["..."],"correctIndex":0}, ...]}`;
  try{
    state.quiz = await askClaude(sys, user, true);
    state.quizIndex = 0;
    state.quizAnswers = [];
    state.screen = "quiz";
  }catch(e){
    alert("Quiz generation failed: " + e.message);
    state.screen = "lesson";
  }
  render();
}
function handleQuizMcq(idx){
  const q = state.quiz.questions[state.quizIndex];
  const correct = idx === q.correctIndex;
  const clickedBtn = document.querySelector(`.mcq-opt[data-qidx="${idx}"]`);
  if(clickedBtn){
    const r = clickedBtn.getBoundingClientRect();
    if(correct) emojiBurst(["🎉","✅","⭐","🔥"], r.left + r.width/2, r.top, 7);
    else emojiBurst(["🤔","💭"], r.left + r.width/2, r.top, 3);
  }
  state.quizAnswers[state.quizIndex] = { selected: idx, correct, feedback: correct ? "🎉 Correct!" : "Not quite — the right answer is: " + q.options[q.correctIndex] };
  render();
}
async function handleQuizFree(){
  const val = document.getElementById("quizFree").value.trim();
  if(!val) return;
  const q = state.quiz.questions[state.quizIndex];
  state.screen = "grading_seg"; render();
  const res = await evaluateFree(q.prompt, val, state.lessonPlan.title);
  state.quizAnswers[state.quizIndex] = { text: val, correct: res.correct, feedback: res.feedback };
  state.screen = "quiz";
  render();
}
function advanceQuiz(){
  zoomAdvance(()=>{
    if(state.quizIndex < state.quiz.questions.length - 1){
      state.quizIndex++;
      render();
    } else {
      buildReport();
    }
  });
}

async function buildReport(){
  state.screen = "report_gen"; render();
  const correctCount = state.quizAnswers.filter(a=>a.correct).length;
  const score = Math.round((correctCount / state.quiz.questions.length) * 100);
  const sys = `You are Guru, summarizing a student's performance. Respond ONLY as JSON.`;
  const user = `Lesson: ${state.lessonPlan.title}. Segments: ${state.lessonPlan.segments.map(s=>s.title).join(", ")}.
Quiz results: ${state.quiz.questions.map((q,i)=>`Q:"${q.prompt}" -> ${state.quizAnswers[i].correct ? "correct" : "incorrect"}`).join("; ")}
Score: ${score}%.
Return JSON: {"strong": ["concept",...], "weak": ["concept",...], "recommendation": "2-3 sentence actionable recommendation in ${langInstruction(state.profile.language)}", "nextTopic": "one suggested next topic, in ${langInstruction(state.profile.language)}"}`;
  try{
    const r = await askClaude(sys, user, true);
    state.report = { score, strong: r.strong||[], weak: r.weak||[], recommendation: r.recommendation||"", nextTopic: r.nextTopic||"" };
  }catch(e){
    state.report = { score, strong: [], weak: [], recommendation: "Review the segments you found difficult and try again.", nextTopic: "" };
  }
  await saveProgress();
  state.screen = "report";
  render();
}

async function saveProgress(){
  try{
    const key = "vidyaguru:learner-history";
    let history = [];
    try{ history = JSON.parse(localStorage.getItem(key) || "[]"); }catch(e){}
    history.push({ topic: state.lessonPlan.title, date: new Date().toISOString(), score: state.report.score, weak: state.report.weak });
    localStorage.setItem(key, JSON.stringify(history));
  }catch(e){ console.warn("Storage unavailable", e); }
}

document.addEventListener("click", (e)=>{
  const btn = e.target.closest(".btn, .mcq-opt, .dropzone");
  if(btn) addRipple.call(null, {currentTarget: btn, clientX: e.clientX, clientY: e.clientY});
});

document.getElementById("muteToggleBtn").onclick = toggleMute;
updateMuteButton();
render();
