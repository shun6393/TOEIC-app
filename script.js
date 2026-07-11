const LS_KEY = "toeic_cram_words_v1";
const SETTINGS_KEY = "toeic_cram_settings_v1";
const PROGRESS_KEY = "toeic_cram_progress_v2";
const CUSTOM_WORDS_KEY = "toeic_cram_custom_words_v2";
const CATALOG_OVERRIDES_KEY = "toeic_cram_catalog_overrides_v2";
const HIDDEN_CATALOG_KEY = "toeic_cram_hidden_catalog_v2";
const STORAGE_MIGRATED_KEY = "toeic_cram_storage_migrated_v2";
const DAILY_KEY = "toeic_cram_daily_v1";
const WORD_STATUS = Object.freeze({UNSEEN:"unseen",LEARNING:"learning",REVIEW:"review",MASTERED:"mastered"});
const DEFAULT_TARGET_SCORE = 600;
const VOCAB_TARGETS = Object.freeze({
  400: 700,
  500: 1100,
  600: 1600,
  700: 2300,
  800: 3200,
  900: 4500
});
const DAILY_REVIEW_MULTIPLIER = 3;
const HIGH_DAILY_NEW_THRESHOLD = 100;
const HIGH_DAILY_REVIEW_THRESHOLD = 300;
const HIGH_TOTAL_ANSWERS_THRESHOLD = 500;
const WORDS_PER_PAGE = 50;
const VALID_SCORE_TIERS = new Set([400,500,600,730,860]);
const CSV_HEADER_FIELDS = new Map([
  ["word","word"], ["meaning","meaning"], ["hint","hint"],
  ["scoretier","scoreTier"], ["targetscore","scoreTier"],
  ["difficulty","difficulty"], ["priority","priority"],
  ["partofspeech","partOfSpeech"], ["tags","tags"], ["level","level"]
]);
const STANDARD_CATALOG_URL = "./toeic-words.csv";
const STANDARD_CATALOG_FIELDS = ["word","meaning","hint","partOfSpeech","scoreTier","difficulty","priority","tags"];

let words = [];
let current = null;
let revealed = false;
let wordListPage = 1;
let pendingDeleteWordId = null;
let studyMode = null;
let dailyActivity = {date:"",newWords:0,reviewAnswers:0};
let standardCatalog = WORD_CATALOG;
let catalogById = new Map();

function now(){ return Date.now(); }
function todayKey(){
  const date=new Date();
  const year=date.getFullYear();
  const month=String(date.getMonth()+1).padStart(2,"0");
  const day=String(date.getDate()).padStart(2,"0");
  return `${year}-${month}-${day}`;
}

function migrateWordStatus(entry){
  if(Object.values(WORD_STATUS).includes(entry.status)) return false;
  if((entry.seen||0)===0) entry.status=WORD_STATUS.UNSEEN;
  else if((entry.level||0)>=4) entry.status=WORD_STATUS.MASTERED;
  else if((entry.level||0)===0) entry.status=WORD_STATUS.LEARNING;
  else entry.status=WORD_STATUS.REVIEW;
  if((entry.seen||0)>0 && !entry.firstLearnedAt) entry.firstLearnedAt=entry.last||0;
  return true;
}

function loadDailyActivity(){
  const saved=JSON.parse(localStorage.getItem(DAILY_KEY)||"{}");
  const date=todayKey();
  const legacyReviews=words.reduce((sum,entry)=>
    sum+(entry.today===date ? Number(entry.todayCount)||0 : 0),0
  );
  dailyActivity=saved.date===date
    ? {date,newWords:Number(saved.newWords)||0,reviewAnswers:Number(saved.reviewAnswers)||0}
    : {date,newWords:0,reviewAnswers:saved.date ? 0 : legacyReviews};
  saveDailyActivity();
}

function saveDailyActivity(){
  localStorage.setItem(DAILY_KEY,JSON.stringify(dailyActivity));
}

function normalizeWord(value){
  return String(value||"").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

const fallbackCatalogIdsByWord=new Map(WORD_CATALOG.map(entry=>[normalizeWord(entry.word),entry.id]));

function createStandardCatalogId(wordValue){
  const normalized=normalizeWord(wordValue);
  const fallbackId=fallbackCatalogIdsByWord.get(normalized);
  if(fallbackId) return fallbackId;
  // 正規化wordのUTF-8バイト列を16進化する。行順に依存せず、空白・記号・Unicodeを区別できる可逆な固定ID。
  const encoded=Array.from(new TextEncoder().encode(normalized),byte=>byte.toString(16).padStart(2,"0")).join("");
  return `catalog_${encoded}`;
}

function rebuildCatalogIndex(){
  catalogById=new Map(standardCatalog.map(entry=>[entry.id,entry]));
}

function scoreTierToUi(scoreTier){
  if(scoreTier===730) return 700;
  if(scoreTier===860) return 800;
  return scoreTier;
}

function uiScoreToTier(score){
  const value=Number(score)||600;
  if(value===700) return 730;
  if(value===800 || value===900) return 860;
  return value;
}

function extractProgress(entry){
  return {
    status:entry.status||WORD_STATUS.UNSEEN,
    level:Number(entry.level)||0,
    correct:Number(entry.correct)||0,
    wrong:Number(entry.wrong)||0,
    next:Number(entry.next)||0,
    seen:Number(entry.seen)||0,
    last:Number(entry.last)||0,
    firstLearnedAt:Number(entry.firstLearnedAt)||0,
    today:entry.today||"",
    todayCount:Number(entry.todayCount)||0,
    memo:entry.memo||""
  };
}

function runtimeWord(content,progress={}){
  const profile=content.learningProfile||{};
  return {
    id:content.id,
    word:content.word,
    meaning:content.meaning,
    hint:content.hint||"",
    partOfSpeech:content.partOfSpeech||"",
    targetScore:scoreTierToUi(Number(profile.scoreTier))||undefined,
    difficulty:Number(profile.difficulty)||3,
    priority:Number(profile.priority)||3,
    tags:Array.isArray(content.tags) ? [...content.tags] : [],
    status:progress.status||WORD_STATUS.UNSEEN,
    level:Number(progress.level)||0,
    correct:Number(progress.correct)||0,
    wrong:Number(progress.wrong)||0,
    next:Number(progress.next)||0,
    seen:Number(progress.seen)||0,
    last:Number(progress.last)||0,
    firstLearnedAt:Number(progress.firstLearnedAt)||0,
    today:progress.today||"",
    todayCount:Number(progress.todayCount)||0,
    memo:progress.memo||""
  };
}

function runtimeContent(entry){
  return {
    id:entry.id,
    word:entry.word,
    meaning:entry.meaning,
    hint:entry.hint||"",
    partOfSpeech:entry.partOfSpeech||"",
    learningProfile:{
      scoreTier:uiScoreToTier(entry.targetScore),
      difficulty:Number(entry.difficulty)||3,
      priority:Number(entry.priority)||3
    },
    tags:Array.isArray(entry.tags) ? [...entry.tags] : []
  };
}

function mergeCatalogContent(base,override={}){
  return {
    ...base,
    ...override,
    learningProfile:{...base.learningProfile,...(override.learningProfile||{})},
    tags:Array.isArray(override.tags) ? override.tags : base.tags
  };
}

function createCatalogOverride(entry,base){
  const content=runtimeContent(entry);
  const override={};
  for(const field of ["word","meaning","hint","partOfSpeech"]){
    if(content[field]!==base[field]) override[field]=content[field];
  }
  const profile={};
  for(const field of ["scoreTier","difficulty","priority"]){
    if(content.learningProfile[field]!==base.learningProfile[field]) profile[field]=content.learningProfile[field];
  }
  if(Object.keys(profile).length) override.learningProfile=profile;
  if(JSON.stringify(content.tags)!==JSON.stringify(base.tags)) override.tags=content.tags;
  return Object.keys(override).length ? override : null;
}

function migrateLegacyStorage(){
  const raw=localStorage.getItem(LS_KEY);
  const legacy=raw ? JSON.parse(raw) : [];
  const unmatched=new Map(legacy.map(entry=>[normalizeWord(entry.word),entry]));
  const progressById={};
  const overrides={};
  const hiddenIds=[];

  for(const catalogEntry of standardCatalog){
    const old=legacy.find(entry=>entry.id===catalogEntry.id) || unmatched.get(normalizeWord(catalogEntry.word));
    if(!old){
      if(raw) hiddenIds.push(catalogEntry.id);
      continue;
    }
    unmatched.delete(normalizeWord(old.word));
    progressById[catalogEntry.id]=extractProgress(old);
    const migratedRuntime=runtimeWord(catalogEntry,extractProgress(old));
    for(const field of ["word","meaning","hint","partOfSpeech","targetScore","difficulty","priority","tags"]){
      if(old[field]!==undefined) migratedRuntime[field]=old[field];
    }
    const override=createCatalogOverride(migratedRuntime,catalogEntry);
    if(override) overrides[catalogEntry.id]=override;
  }

  const customWords=[];
  for(const old of unmatched.values()){
    const id=catalogById.has(old.id) ? `custom_${crypto.randomUUID()}` : old.id;
    const runtime={...old,id};
    customWords.push(runtimeContent(runtime));
    progressById[id]=extractProgress(old);
  }
  localStorage.setItem(PROGRESS_KEY,JSON.stringify(progressById));
  localStorage.setItem(CUSTOM_WORDS_KEY,JSON.stringify(customWords));
  localStorage.setItem(CATALOG_OVERRIDES_KEY,JSON.stringify(overrides));
  localStorage.setItem(HIDDEN_CATALOG_KEY,JSON.stringify(hiddenIds));
  localStorage.setItem(STORAGE_MIGRATED_KEY,"1");
}

function loadSeparatedWords(){
  if(localStorage.getItem(STORAGE_MIGRATED_KEY)!=="1") migrateLegacyStorage();
  const progress=JSON.parse(localStorage.getItem(PROGRESS_KEY)||"{}");
  const custom=JSON.parse(localStorage.getItem(CUSTOM_WORDS_KEY)||"[]");
  const overrides=JSON.parse(localStorage.getItem(CATALOG_OVERRIDES_KEY)||"{}");
  const hidden=new Set(JSON.parse(localStorage.getItem(HIDDEN_CATALOG_KEY)||"[]"));
  const builtIn=standardCatalog
    .filter(entry=>!hidden.has(entry.id))
    .map(entry=>runtimeWord(mergeCatalogContent(entry,overrides[entry.id]),progress[entry.id]));
  const customRuntime=custom.map(entry=>runtimeWord(entry,progress[entry.id]));
  return [...builtIn,...customRuntime];
}

function ensureCurrentDailyActivity(){
  if(dailyActivity.date!==todayKey()){
    dailyActivity={date:todayKey(),newWords:0,reviewAnswers:0};
    saveDailyActivity();
  }
}

function load(){
  words=loadSeparatedWords();
  let migrated=false;
  words.forEach(entry=>{if(migrateWordStatus(entry)) migrated=true;});
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");
  examDate.value = settings.examDate || "2026-07-21";
  targetScore.value = VOCAB_TARGETS[settings.targetScore]
    ? settings.targetScore
    : DEFAULT_TARGET_SCORE;
  dailyGoal.value = settings.dailyGoal || 100;
  loadDailyActivity();
  if(migrated) save();
  refreshStats();
}

function save(){
  const progress={};
  const custom=[];
  const overrides={};
  const activeIds=new Set(words.map(entry=>entry.id));
  for(const entry of words){
    progress[entry.id]=extractProgress(entry);
    const base=catalogById.get(entry.id);
    if(base){
      const override=createCatalogOverride(entry,base);
      if(override) overrides[entry.id]=override;
    } else {
      custom.push(runtimeContent(entry));
    }
  }
  const hidden=standardCatalog.filter(entry=>!activeIds.has(entry.id)).map(entry=>entry.id);
  localStorage.setItem(PROGRESS_KEY,JSON.stringify(progress));
  localStorage.setItem(CUSTOM_WORDS_KEY,JSON.stringify(custom));
  localStorage.setItem(CATALOG_OVERRIDES_KEY,JSON.stringify(overrides));
  localStorage.setItem(HIDDEN_CATALOG_KEY,JSON.stringify(hidden));
  localStorage.setItem(STORAGE_MIGRATED_KEY,"1");
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    examDate: examDate.value,
    targetScore: Number(targetScore.value) || DEFAULT_TARGET_SCORE,
    dailyGoal: Number(dailyGoal.value)||100
  }));
}

function dueWords(){
  const t = now();
  return words.filter(w => w.status!==WORD_STATUS.UNSEEN && (w.next||0) <= t);
}

function chooseNext(){
  modeBadge.textContent=studyMode==="new" ? "新規学習" : "復習";
  const candidates=studyMode==="new"
    ? words.filter(entry=>entry.status===WORD_STATUS.UNSEEN)
    : dueWords();
  if(!candidates.length){
    current = null;
    word.textContent = studyMode==="new" ? "未学習の単語はなし" : "今すぐ復習する単語はなし";
    meaning.textContent = "";
    hint.textContent = studyMode==="new"
      ? "単語を追加するか、復習モードを選んでください。"
      : "少し時間を置くか、新規学習を進めてください。";
    meaning.style.display = "none";
    hint.style.display = "block";
    tapText.textContent = "";
    setButtons(false);
    refreshStats();
    return;
  }
  if(studyMode==="new"){
    candidates.sort((a,b)=>(b.priority||0)-(a.priority||0));
  } else {
    const order={[WORD_STATUS.LEARNING]:0,[WORD_STATUS.REVIEW]:1,[WORD_STATUS.MASTERED]:2};
    candidates.sort((a,b)=>
      (order[a.status]??3)-(order[b.status]??3) ||
      (a.next||0)-(b.next||0) ||
      (a.level||0)-(b.level||0)
    );
  }
  current = candidates[0];
  revealed = false;
  word.textContent = current.word;
  meaning.textContent = current.meaning;
  hint.textContent = current.hint || "";
  meaning.style.display = "none";
  hint.style.display = "none";
  tapText.textContent = "カードを押すと答えを表示";
  setButtons(false);
  refreshStats();
}

function reveal(){
  if(!current || revealed) return;
  revealed = true;
  meaning.style.display = "block";
  if(current.hint) hint.style.display = "block";
  tapText.textContent = "自己評価してね";
  setButtons(true);
}

function setButtons(on){
  badBtn.disabled = !on; midBtn.disabled = !on; goodBtn.disabled = !on;
}

function answer(type){
  if(!current) return;
  ensureCurrentDailyActivity();
  const t = now();
  const isNew=current.status===WORD_STATUS.UNSEEN;
  if(isNew){
    dailyActivity.newWords++;
    current.firstLearnedAt=t;
  } else {
    dailyActivity.reviewAnswers++;
  }
  current.seen = (current.seen||0)+1;
  current.last = t;
  const td = todayKey();
  current.today = current.today===td ? td : td;
  current.todayCount = (current.todayCount||0)+1;

  if(type==="bad"){
    current.wrong=(current.wrong||0)+1;
    current.level=Math.max(0,(current.level||0)-1);
    current.next=t+10*60*1000;
    current.status=WORD_STATUS.LEARNING;
  } else if(type==="mid"){
    current.next=t+60*60*1000;
    current.status=(isNew || current.status===WORD_STATUS.LEARNING)
      ? WORD_STATUS.LEARNING
      : WORD_STATUS.REVIEW;
  } else {
    current.correct=(current.correct||0)+1;
    current.level=Math.min(6,(current.level||0)+1);
    const intervals=[2,6,12,24,48,96,168]; // hours
    current.next=t+intervals[current.level]*60*60*1000;
    current.status=current.level>=4 ? WORD_STATUS.MASTERED : WORD_STATUS.REVIEW;
  }
  saveDailyActivity();
  save();
  chooseNext();
}

function refreshStats(){
  ensureCurrentDailyActivity();
  const due=dueWords().length;
  const counts={unseen:0,learning:0,review:0,mastered:0};
  words.forEach(entry=>{if(counts[entry.status]!==undefined) counts[entry.status]++;});
  const today=dailyActivity.newWords+dailyActivity.reviewAnswers;
  dueCount.textContent=due;
  todayNewCount.textContent=dailyActivity.newWords;
  todayReviewCount.textContent=dailyActivity.reviewAnswers;
  unseenCount.textContent=counts.unseen;
  learningCount.textContent=counts.learning;
  reviewCount.textContent=counts.review;
  masteredCount.textContent=counts.mastered;
  const dateInfo=getStudyDateInfo();
  daysLeft.textContent=dateInfo.days;
  const goal=Number(dailyGoal.value)||100;
  goalBar.style.width=Math.min(100,today/goal*100)+"%";
  goalText.textContent=`今日 ${today} / ${goal} 回回答`;
  refreshStudyPlan(dateInfo,due,counts);
  renderWordList();
}

function getStudyDateInfo(){
  if(!examDate.value) return {days:0,isToday:false,isPast:false,valid:false};
  const [year,month,day]=examDate.value.split("-").map(Number);
  const today=new Date();
  const todayUtc=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate());
  const examUtc=Date.UTC(year,month-1,day);
  const difference=Math.round((examUtc-todayUtc)/86400000);
  const valid=Number.isFinite(difference);
  return {
    days:valid ? Math.max(0,difference) : 0,
    isToday:valid && difference===0,
    isPast:valid && difference<0,
    valid
  };
}

function setProgressBar(element,value,target){
  element.style.width=(target>0 ? Math.min(100,value/target*100) : 0)+"%";
}

function refreshStudyPlan(dateInfo,due,counts){
  const score=Number(targetScore.value)||DEFAULT_TARGET_SCORE;
  const target=VOCAB_TARGETS[score];
  const studied=counts.learning+counts.review+counts.mastered;
  const remaining=Math.max(0,target-studied);
  const dailyNewEstimate=dateInfo.days>0 ? Math.ceil(remaining/dateInfo.days) : 0;
  const reviewEstimate=dateInfo.days>0
    ? Math.max(due,dailyNewEstimate*DAILY_REVIEW_MULTIPLIER)
    : 0;
  const todayNewGoal=dateInfo.days>0 ? Math.min(dailyNewEstimate,counts.unseen) : 0;
  const todayReviewGoal=dateInfo.days>0
    ? Math.max(due,todayNewGoal*DAILY_REVIEW_MULTIPLIER)
    : 0;
  const overallPercent=target>0 ? Math.min(100,studied/target*100) : 0;

  vocabTarget.textContent=`約${target.toLocaleString("ja-JP")}語`;
  registeredPlanCount.textContent=`${words.length.toLocaleString("ja-JP")}語`;
  studiedPlanCount.textContent=`${studied.toLocaleString("ja-JP")}語`;
  remainingNew.textContent=`${remaining.toLocaleString("ja-JP")}語`;
  planDaysLeft.textContent=`${dateInfo.days.toLocaleString("ja-JP")}日`;
  dailyNew.textContent=`${dailyNewEstimate.toLocaleString("ja-JP")}語`;
  dailyReview.textContent=`${reviewEstimate.toLocaleString("ja-JP")}回`;
  todayNewPlanText.textContent=`${dailyActivity.newWords.toLocaleString("ja-JP")}語 / ${todayNewGoal.toLocaleString("ja-JP")}語`;
  todayReviewPlanText.textContent=`${dailyActivity.reviewAnswers.toLocaleString("ja-JP")}回 / ${todayReviewGoal.toLocaleString("ja-JP")}回`;
  overallPlanText.textContent=`${studied.toLocaleString("ja-JP")}語 / ${target.toLocaleString("ja-JP")}語（${Math.round(overallPercent)}%）`;
  setProgressBar(todayNewBar,dailyActivity.newWords,todayNewGoal);
  setProgressBar(todayReviewBar,dailyActivity.reviewAnswers,todayReviewGoal);
  overallPlanBar.style.width=overallPercent+"%";

  const warnings=[];
  if(!dateInfo.valid){
    warnings.push("試験日を設定してください。");
  } else if(dateInfo.isPast){
    warnings.push("試験日を過ぎています。新しい試験日を設定してください。");
  } else if(dateInfo.isToday){
    warnings.push("試験日は今日です。新しい長期計画は作成できないため、復習時刻が来ている単語を優先してください。");
  }
  if(words.length<target){
    warnings.push(`目標${score}点の語彙数目安まで、約${(target-words.length).toLocaleString("ja-JP")}語の追加登録が必要です。`);
  }
  if(dateInfo.days>0 && counts.unseen<dailyNewEstimate){
    warnings.push(`今日の必要新規数は${dailyNewEstimate.toLocaleString("ja-JP")}語ですが、登録済みの未学習単語は${counts.unseen.toLocaleString("ja-JP")}語です。`);
  }
  if(dailyNewEstimate>HIGH_DAILY_NEW_THRESHOLD || reviewEstimate>HIGH_DAILY_REVIEW_THRESHOLD || dailyNewEstimate+reviewEstimate>HIGH_TOTAL_ANSWERS_THRESHOLD){
    warnings.push(`1日あたり新規${dailyNewEstimate.toLocaleString("ja-JP")}語・復習${reviewEstimate.toLocaleString("ja-JP")}回の計画です。継続が難しい可能性があるため、試験日や目標点数を見直してください。`);
  }
  planWarnings.replaceChildren();
  for(const warning of warnings){
    const item=document.createElement("li");
    item.textContent=warning;
    planWarnings.appendChild(item);
  }
  planWarnings.style.display=warnings.length ? "block" : "none";
  planNotice.textContent=`学習開始済み${studied.toLocaleString("ja-JP")}語、定着済み${counts.mastered.toLocaleString("ja-JP")}語を基準に計算しています。`;
}

function getWordStatus(entry){
  if(entry.status===WORD_STATUS.UNSEEN) return {label:"未学習",className:"status-unseen"};
  if(entry.status===WORD_STATUS.LEARNING) return {label:"学習中",className:"status-learning"};
  if(entry.status===WORD_STATUS.MASTERED) return {label:"定着済み",className:"status-mastered"};
  return {label:"復習対象",className:"status-review"};
}

function appendWordCell(row, text, label, className=""){
  const cell=document.createElement("td");
  cell.textContent=text;
  cell.dataset.label=label;
  if(className) cell.className=className;
  row.appendChild(cell);
  return cell;
}

function openModal(dialog){
  if(typeof dialog.showModal==="function") dialog.showModal();
  else dialog.setAttribute("open","");
}

function closeModal(dialog){
  if(typeof dialog.close==="function") dialog.close();
  else dialog.removeAttribute("open");
}

function toDateTimeLocal(timestamp){
  if(!timestamp) return "";
  const date=new Date(timestamp);
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}

function openWordEditor(id){
  const entry=words.find(word=>word.id===id);
  if(!entry) return;
  editWordId.value=entry.id;
  editWord.value=entry.word;
  editMeaning.value=entry.meaning;
  editHint.value=entry.hint||"";
  editLevel.value=entry.level||0;
  editStatus.value=entry.status;
  editSeen.value=entry.seen||0;
  editCorrect.value=entry.correct||0;
  editWrong.value=entry.wrong||0;
  editNext.value=toDateTimeLocal(entry.next||0);
  editTargetScore.value=entry.targetScore||"";
  editPriority.value=entry.priority||"";
  editPartOfSpeech.value=entry.partOfSpeech||"";
  editHistoryInfo.textContent=entry.last
    ? `最終回答：${new Date(entry.last).toLocaleString("ja-JP")}（単語IDは変更されません）`
    : "学習履歴はまだありません（単語IDは変更されません）。";
  editWordError.textContent="";
  openModal(editWordDialog);
}

function openDeleteConfirmation(id){
  const entry=words.find(word=>word.id===id);
  if(!entry) return;
  pendingDeleteWordId=entry.id;
  deleteWordMessage.textContent=`「${entry.word}」を削除しますか？`;
  const hasHistory=(entry.seen||0)>0 || (entry.correct||0)>0 || (entry.wrong||0)>0;
  deleteHistoryInfo.textContent=hasHistory
    ? `学習回数：${entry.seen||0}回／正解：${entry.correct||0}回／不正解：${entry.wrong||0}回／習熟レベル：${entry.level||0}。単語を削除すると、この学習履歴も削除されます。`
    : "この単語には学習履歴がありません。";
  openModal(deleteWordDialog);
}

function renderWordList(){
  const query=wordSearch.value.trim().toLocaleLowerCase("ja-JP");
  const filtered=words.filter(entry=>
    entry.word.toLocaleLowerCase("ja-JP").includes(query) ||
    entry.meaning.toLocaleLowerCase("ja-JP").includes(query)
  );
  const totalPages=Math.max(1,Math.ceil(filtered.length/WORDS_PER_PAGE));
  wordListPage=Math.min(Math.max(1,wordListPage),totalPages);
  const start=(wordListPage-1)*WORDS_PER_PAGE;
  const visible=filtered.slice(start,start+WORDS_PER_PAGE);

  registeredCount.textContent=words.length.toLocaleString("ja-JP");
  searchResultCount.textContent=query
    ? `検索結果 ${filtered.length.toLocaleString("ja-JP")} / ${words.length.toLocaleString("ja-JP")}語`
    : `全${words.length.toLocaleString("ja-JP")}語`;
  wordListBody.replaceChildren();

  for(const entry of visible){
    const row=document.createElement("tr");
    appendWordCell(row,entry.word,"英単語");
    appendWordCell(row,entry.meaning,"意味");
    appendWordCell(row,entry.hint||"—","ヒント");
    const status=getWordStatus(entry);
    const statusCell=appendWordCell(row,"","学習状況");
    const badge=document.createElement("span");
    badge.className=`status ${status.className}`;
    badge.textContent=status.label;
    statusCell.appendChild(badge);
    const actionCell=appendWordCell(row,"","操作","word-actions");
    const editButton=document.createElement("button");
    editButton.type="button";
    editButton.className="ghost";
    editButton.textContent="編集";
    editButton.addEventListener("click",()=>openWordEditor(entry.id));
    const deleteButton=document.createElement("button");
    deleteButton.type="button";
    deleteButton.className="danger";
    deleteButton.textContent="削除";
    deleteButton.addEventListener("click",()=>openDeleteConfirmation(entry.id));
    actionCell.append(editButton,deleteButton);
    wordListBody.appendChild(row);
  }

  wordListEmpty.style.display=filtered.length ? "none" : "block";
  pageInfo.textContent=`${wordListPage} / ${totalPages}ページ`;
  prevPageBtn.disabled=wordListPage===1;
  nextPageBtn.disabled=wordListPage===totalPages;
}

function parseCsv(text){
  const records=[];
  const errors=[];
  let row=[];
  let field="";
  let inQuotes=false;
  let line=1;
  let recordLine=1;
  let invalidLine=null;

  function finishRecord(){
    row.push(field);
    if(row.some(value=>value.trim()!=="")) records.push({line:recordLine,cells:row,invalidLine});
    row=[];
    field="";
    invalidLine=null;
    recordLine=line;
  }

  const source=text.replace(/^\uFEFF/,"");
  for(let index=0;index<source.length;index++){
    const char=source[index];
    if(inQuotes){
      if(char==='"'){
        if(source[index+1]==='"'){
          field+='"';
          index++;
        } else {
          inQuotes=false;
        }
      } else {
        field+=char;
        if(char==="\n") line++;
      }
      continue;
    }
    if(char==='"'){
      if(field.trim()===""){
        field="";
        inQuotes=true;
      } else {
        invalidLine=invalidLine||line;
        field+=char;
      }
    } else if(char===","){
      row.push(field);
      field="";
    } else if(char==="\n"){
      finishRecord();
      line++;
      recordLine=line;
    } else if(char!=="\r"){
      field+=char;
    }
  }
  if(inQuotes){
    errors.push({line:recordLine,reason:"ダブルクォートが閉じていません。"});
  } else if(field!=="" || row.length){
    finishRecord();
  }
  return {records,errors};
}

function normalizeHeader(value){
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s_-]/g,"");
}

function mapCsvHeader(record){
  const map={};
  if(!record) return map;
  record.cells.map(normalizeHeader).forEach((name,index)=>{
    const fieldName=CSV_HEADER_FIELDS.get(name);
    if(fieldName && map[fieldName]===undefined) map[fieldName]=index;
  });
  return map;
}

function getCsvColumnMap(records){
  const first=records[0];
  const normalized=first ? first.cells.map(normalizeHeader) : [];
  const autoHeader=normalized.includes("word") && normalized.includes("meaning");
  const hasHeader=headerMode.value==="yes" || (headerMode.value==="auto" && autoHeader);
  if(!hasHeader){
    const legacyMap=fourthColumnType.value==="legacyLevel"
      ? {word:0,meaning:1,hint:2,level:3,priority:4,partOfSpeech:5}
      : {word:0,meaning:1,hint:2,scoreTier:3,priority:4,partOfSpeech:5};
    return {
      hasHeader:false,
      map:fourthColumnType.value==="catalog"
        ? {word:0,meaning:1,hint:2,partOfSpeech:3,scoreTier:4,difficulty:5,priority:6,tags:7}
        : legacyMap,
      errors:[]
    };
  }
  const map=mapCsvHeader(first);
  const errors=[];
  const headerLine=first ? first.line : 1;
  if(map.word===undefined) errors.push({line:headerLine,reason:"ヘッダーにword列がありません。"});
  if(map.meaning===undefined) errors.push({line:headerLine,reason:"ヘッダーにmeaning列がありません。"});
  return {hasHeader:true,map,errors};
}

function csvValue(cells,map,name){
  return map[name]===undefined ? "" : (cells[map[name]]||"").trim();
}

function normalizeCsvScoreTier(rawValue){
  if(rawValue==="") return 600;
  if(!/^\d+$/.test(rawValue)) return null;
  const converted=uiScoreToTier(Number(rawValue));
  return VALID_SCORE_TIERS.has(converted) ? converted : null;
}

function parseCsvTags(rawValue){
  const tags=[];
  const known=new Set();
  for(const value of rawValue.split("|")){
    const tag=value.trim();
    const normalized=tag.toLocaleLowerCase("en-US");
    if(!tag || known.has(normalized)) continue;
    known.add(normalized);
    tags.push(tag);
  }
  return tags;
}

function parseStandardCatalogCsv(text){
  const parsed=parseCsv(text);
  const header=parsed.records[0];
  if(!header) throw new Error("標準CSVにヘッダーがありません。");
  const map=mapCsvHeader(header);
  const missing=STANDARD_CATALOG_FIELDS.filter(field=>map[field]===undefined);
  if(missing.length) throw new Error(`標準CSVに必要な列がありません: ${missing.join(", ")}`);

  const catalog=[];
  const errors=[...parsed.errors];
  const knownWords=new Set();
  for(const record of parsed.records.slice(1)){
    const wordValue=csvValue(record.cells,map,"word");
    const meaningValue=csvValue(record.cells,map,"meaning");
    const scoreTierValue=csvValue(record.cells,map,"scoreTier");
    const difficultyValue=csvValue(record.cells,map,"difficulty");
    const priorityValue=csvValue(record.cells,map,"priority");
    let reason="";
    if(record.invalidLine) reason="値の途中に不正なダブルクォートがあります。";
    else if(!wordValue) reason="wordが空です。";
    else if(!meaningValue) reason="meaningが空です。";
    else if(!/^\d+$/.test(scoreTierValue) || !VALID_SCORE_TIERS.has(uiScoreToTier(Number(scoreTierValue)))) reason="scoreTierが不正です。";
    else if(!/^[1-5]$/.test(difficultyValue)) reason="difficultyが1〜5ではありません。";
    else if(!/^[1-5]$/.test(priorityValue)) reason="priorityが1〜5ではありません。";
    const normalized=normalizeWord(wordValue);
    if(!reason && knownWords.has(normalized)) reason="同じwordが標準CSV内で重複しています。";
    if(reason){
      errors.push({line:record.line,reason});
      continue;
    }
    knownWords.add(normalized);
    catalog.push({
      id:createStandardCatalogId(wordValue),
      word:wordValue,
      meaning:meaningValue,
      hint:csvValue(record.cells,map,"hint"),
      partOfSpeech:csvValue(record.cells,map,"partOfSpeech"),
      learningProfile:{
        scoreTier:uiScoreToTier(Number(scoreTierValue)),
        difficulty:Number(difficultyValue),
        priority:Number(priorityValue)
      },
      tags:parseCsvTags(csvValue(record.cells,map,"tags"))
    });
  }
  if(!catalog.length) throw new Error("標準CSVから有効な単語を読み込めませんでした。");
  return {catalog,errors};
}

async function loadStandardCatalog(){
  const response=await fetch(STANDARD_CATALOG_URL,{cache:"no-cache"});
  if(!response.ok) throw new Error(`標準CSVの取得に失敗しました（HTTP ${response.status}）。`);
  const result=parseStandardCatalogCsv(await response.text());
  if(result.errors.length){
    console.warn(`標準CSVの不正な${result.errors.length}件を除外しました。`,result.errors);
  }
  return result;
}

function validateCsvRow(record,map){
  const value={
    word:csvValue(record.cells,map,"word"),
    meaning:csvValue(record.cells,map,"meaning"),
    hint:csvValue(record.cells,map,"hint"),
    scoreTier:csvValue(record.cells,map,"scoreTier"),
    difficulty:csvValue(record.cells,map,"difficulty"),
    level:csvValue(record.cells,map,"level"),
    priority:csvValue(record.cells,map,"priority"),
    partOfSpeech:csvValue(record.cells,map,"partOfSpeech"),
    tags:csvValue(record.cells,map,"tags")
  };
  if(record.invalidLine) return {error:"値の途中に不正なダブルクォートがあります。"};
  if(!value.word) return {error:"wordが空です。"};
  if(!value.meaning) return {error:"meaningが空です。"};
  const normalizedScoreTier=normalizeCsvScoreTier(value.scoreTier);
  if(normalizedScoreTier===null){
    return {error:"scoreTierは400、500、600、730、860で指定してください（700、800、900も変換できます）。"};
  }
  if(value.difficulty && (!/^\d+$/.test(value.difficulty) || Number(value.difficulty)<1 || Number(value.difficulty)>5)){
    return {error:"difficultyは1〜5の整数で指定してください。"};
  }
  if(value.level && (!/^\d+$/.test(value.level) || Number(value.level)>6)){
    return {error:"levelは0〜6の整数で指定してください。"};
  }
  if(value.priority && (!/^\d+$/.test(value.priority) || Number(value.priority)<1 || Number(value.priority)>5)){
    return {error:"priorityは1〜5の整数で指定してください。"};
  }
  return {value:{
    ...value,
    scoreTier:normalizedScoreTier,
    difficulty:value.difficulty ? Number(value.difficulty) : 3,
    priority:value.priority ? Number(value.priority) : 3,
    tags:parseCsvTags(value.tags)
  }};
}

function showImportResult(success,duplicates,errors){
  importSuccessCount.textContent=success;
  importDuplicateCount.textContent=duplicates;
  importErrorCount.textContent=errors.length;
  importErrorList.replaceChildren();
  for(const error of errors){
    const item=document.createElement("li");
    item.textContent=`${error.line}行目：${error.reason}`;
    importErrorList.appendChild(item);
  }
  importErrorDetails.style.display=errors.length ? "block" : "none";
  importErrorDetails.open=errors.length>0;
  importResult.style.display="block";
}

function importCsvText(text){
  const parsed=parseCsv(text);
  const columnInfo=getCsvColumnMap(parsed.records);
  const errors=[...parsed.errors,...columnInfo.errors];
  if(columnInfo.errors.length){
    showImportResult(0,0,errors);
    return;
  }
  const records=columnInfo.hasHeader ? parsed.records.slice(1) : parsed.records;
  const knownWords=new Set(words.map(entry=>entry.word.trim().toLocaleLowerCase("en-US")));
  let added=0;
  let duplicates=0;

  for(const record of records){
    const result=validateCsvRow(record,columnInfo.map);
    if(result.error){
      errors.push({line:record.line,reason:result.error});
      continue;
    }
    const value=result.value;
    const normalized=value.word.toLocaleLowerCase("en-US");
    if(knownWords.has(normalized)){
      duplicates++;
      continue;
    }
    knownWords.add(normalized);
    words.push({
      id:crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()),
      word:value.word, meaning:value.meaning, hint:value.hint,
      targetScore:scoreTierToUi(value.scoreTier),
      difficulty:value.difficulty,
      priority:value.priority,
      partOfSpeech:value.partOfSpeech,
      tags:value.tags,
      status:WORD_STATUS.UNSEEN,
      level:value.level ? Number(value.level) : 0,
      correct:0, wrong:0, next:0, seen:0, last:0
    });
    added++;
  }
  if(added) save();
  refreshStats();
  showImportResult(added,duplicates,errors);
}

function escapeCsvCell(value){
  const text=String(value??"");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text;
}

function buildCatalogCsv(){
  const header=["word","meaning","hint","partOfSpeech","scoreTier","difficulty","priority","tags"];
  const rows=words.map(entry=>{
    const content=runtimeContent(entry);
    return [
      content.word,
      content.meaning,
      content.hint,
      content.partOfSpeech,
      content.learningProfile.scoreTier,
      content.learningProfile.difficulty,
      content.learningProfile.priority,
      content.tags.join("|")
    ];
  });
  return [header,...rows].map(row=>row.map(escapeCsvCell).join(",")).join("\r\n");
}

function saveCatalogCsvFile(){
  const csv=`\uFEFF${buildCatalogCsv()}`;
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;
  link.download=`toeic-words-${todayKey().replace(/-/g,"")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

card.addEventListener("click", reveal);
newStartBtn.addEventListener("click",()=>{studyMode="new";chooseNext();});
startBtn.addEventListener("click",()=>{studyMode="review";chooseNext();});
badBtn.addEventListener("click",()=>answer("bad"));
midBtn.addEventListener("click",()=>answer("mid"));
goodBtn.addEventListener("click",()=>answer("good"));

examDate.addEventListener("change",()=>{save();refreshStats();});
targetScore.addEventListener("change",()=>{save();refreshStats();});
dailyGoal.addEventListener("change",()=>{save();refreshStats();});
wordSearch.addEventListener("input",()=>{wordListPage=1;renderWordList();});
prevPageBtn.addEventListener("click",()=>{wordListPage--;renderWordList();});
nextPageBtn.addEventListener("click",()=>{wordListPage++;renderWordList();});
editCancelBtn.addEventListener("click",()=>closeModal(editWordDialog));
editCancelTopBtn.addEventListener("click",()=>closeModal(editWordDialog));
deleteCancelBtn.addEventListener("click",()=>{pendingDeleteWordId=null;closeModal(deleteWordDialog);});
deleteCancelTopBtn.addEventListener("click",()=>{pendingDeleteWordId=null;closeModal(deleteWordDialog);});

editWordForm.addEventListener("submit",event=>{
  event.preventDefault();
  const entry=words.find(word=>word.id===editWordId.value);
  if(!entry) return;
  const updatedWord=editWord.value.trim();
  const updatedMeaning=editMeaning.value.trim();
  if(!updatedWord || !updatedMeaning){
    editWordError.textContent="英単語と日本語の意味は必須です。";
    return;
  }
  const duplicate=words.some(word=>
    word.id!==entry.id && word.word.trim().toLocaleLowerCase("en-US")===updatedWord.toLocaleLowerCase("en-US")
  );
  if(duplicate){
    editWordError.textContent="同じ英単語がすでに登録されています。";
    return;
  }
  const updatedSeen=Math.max(0,Number(editSeen.value)||0);
  const updatedCorrect=Math.max(0,Number(editCorrect.value)||0);
  const updatedWrong=Math.max(0,Number(editWrong.value)||0);
  const updatedPriority=editPriority.value==="" ? undefined : Number(editPriority.value);
  if(updatedPriority!==undefined && (!Number.isInteger(updatedPriority) || updatedPriority<1 || updatedPriority>5)){
    editWordError.textContent="優先度は1〜5の整数で指定してください。";
    return;
  }
  if(updatedCorrect+updatedWrong>updatedSeen){
    editWordError.textContent="学習回数は、正解回数と不正解回数の合計以上にしてください。";
    return;
  }
  if(editStatus.value===WORD_STATUS.UNSEEN && updatedSeen>0){
    editWordError.textContent="未学習に戻す場合は、学習回数を0にしてください。";
    return;
  }
  if(editStatus.value===WORD_STATUS.MASTERED && Number(editLevel.value)<4){
    editWordError.textContent="定着済みにする場合は、習熟レベルを4以上にしてください。";
    return;
  }

  entry.word=updatedWord;
  entry.meaning=updatedMeaning;
  entry.hint=editHint.value.trim();
  entry.level=Math.min(6,Math.max(0,Number(editLevel.value)||0));
  entry.status=editStatus.value;
  entry.seen=updatedSeen;
  entry.correct=updatedCorrect;
  entry.wrong=updatedWrong;
  entry.next=editNext.value ? new Date(editNext.value).getTime() : 0;
  entry.targetScore=editTargetScore.value ? Number(editTargetScore.value) : undefined;
  entry.priority=updatedPriority;
  entry.partOfSpeech=editPartOfSpeech.value.trim()||undefined;
  if(current && current.id===entry.id){
    word.textContent=entry.word;
    meaning.textContent=entry.meaning;
    hint.textContent=entry.hint;
    if(revealed) hint.style.display=entry.hint ? "block" : "none";
  }
  save();
  refreshStats();
  closeModal(editWordDialog);
});

confirmDeleteBtn.addEventListener("click",()=>{
  const index=words.findIndex(word=>word.id===pendingDeleteWordId);
  if(index<0) return;
  const deletingCurrent=Boolean(current && current.id===words[index].id);
  words.splice(index,1);
  pendingDeleteWordId=null;
  save();
  closeModal(deleteWordDialog);
  if(deletingCurrent){
    current=null;
    chooseNext();
  } else {
    refreshStats();
  }
});

resetTodayBtn.addEventListener("click",()=>{
  const td=todayKey();
  words.forEach(w=>{ if(w.today===td) w.todayCount=0; });
  dailyActivity={date:td,newWords:0,reviewAnswers:0};
  saveDailyActivity();
  save(); refreshStats();
});

addBtn.addEventListener("click",()=>importCsvText(importBox.value));

csvFile.addEventListener("change",()=>{
  const file=csvFile.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.addEventListener("load",()=>{importBox.value=String(reader.result||"");});
  reader.addEventListener("error",()=>showImportResult(0,0,[{line:1,reason:"CSVファイルを読み込めませんでした。"}]));
  reader.readAsText(file,"UTF-8");
});

headerMode.addEventListener("change",()=>{
  fourthColumnLabel.style.display=headerMode.value==="yes" ? "none" : "flex";
});

exportBtn.addEventListener("click",()=>{
  importBox.value=buildCatalogCsv();
});
saveCsvBtn.addEventListener("click",saveCatalogCsvFile);

resetAllBtn.addEventListener("click",()=>{
  if(!confirm("単語と学習履歴を全部消す？")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(PROGRESS_KEY);
  localStorage.removeItem(CUSTOM_WORDS_KEY);
  localStorage.removeItem(CATALOG_OVERRIDES_KEY);
  localStorage.removeItem(HIDDEN_CATALOG_KEY);
  dailyActivity={date:todayKey(),newWords:0,reviewAnswers:0};
  saveDailyActivity();
  words=standardCatalog.map(entry=>runtimeWord(entry));
  save(); chooseNext(); refreshStats();
});

const initializationControls=[
  newStartBtn,startBtn,resetTodayBtn,examDate,targetScore,dailyGoal,wordSearch,
  csvFile,headerMode,fourthColumnType,addBtn,exportBtn,saveCsvBtn,resetAllBtn
];

function setAppLoading(isLoading){
  initializationControls.forEach(control=>{control.disabled=isLoading;});
  if(isLoading) catalogLoadStatus.textContent="標準単語データを読み込んでいます…";
}

async function initializeApp(){
  setAppLoading(true);
  let usedFallback=false;
  try{
    const result=await loadStandardCatalog();
    standardCatalog=result.catalog;
    catalogLoadStatus.textContent=`標準単語 ${standardCatalog.length.toLocaleString("ja-JP")}語を読み込みました。`;
  } catch(error){
    usedFallback=true;
    standardCatalog=WORD_CATALOG;
    catalogLoadStatus.textContent=`標準CSVを読み込めなかったため、内蔵の${standardCatalog.length}語で起動しました。`;
    console.warn("標準CSVの読み込みに失敗し、WORD_CATALOGへフォールバックしました。",error);
  }
  rebuildCatalogIndex();
  load();
  setAppLoading(false);
  document.documentElement.dataset.catalogSource=usedFallback ? "fallback" : "csv";
}

initializeApp().catch(error=>{
  catalogLoadStatus.textContent="アプリの初期化に失敗しました。保存データは変更していません。";
  console.error("アプリの初期化に失敗しました。",error);
});
