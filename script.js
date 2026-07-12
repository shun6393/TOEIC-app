const LS_KEY = "toeic_cram_words_v1";
const SETTINGS_KEY = "toeic_cram_settings_v1";
const PROGRESS_KEY = "toeic_cram_progress_v2";
const CUSTOM_WORDS_KEY = "toeic_cram_custom_words_v2";
const CATALOG_OVERRIDES_KEY = "toeic_cram_catalog_overrides_v2";
const HIDDEN_CATALOG_KEY = "toeic_cram_hidden_catalog_v2";
const STORAGE_MIGRATED_KEY = "toeic_cram_storage_migrated_v2";
const DAILY_KEY = "toeic_cram_daily_v1";
const CATALOG_CSV_MIGRATED_KEY = "toeic_cram_catalog_csv_migrated_v1";
const CATALOG_CSV_BACKUP_KEY = "toeic_cram_catalog_csv_backup_v1";
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
const HIGH_DAILY_NEW_THRESHOLD = 100;
const HIGH_DAILY_REVIEW_THRESHOLD = 300;
const HIGH_TOTAL_ANSWERS_THRESHOLD = 500;
const WORDS_PER_PAGE = 50;
const VALID_SCORE_TIERS = new Set([400,500,600,730,860]);
const REVIEW_CONFIG = Object.freeze({
  scheduleVersion:1,
  learningAgainMinutes:10,
  learningHardMinutes:60,
  learningGoodMinutes:360,
  learningStepOneHardMinutes:180,
  initialReviewStrengthHours:24,
  goodEarlyMultiplier:1.5,
  goodOnTimeMultiplier:1.8,
  goodLateMultiplier:2.2,
  hardStrengthMultiplier:1.1,
  hardIntervalMultiplier:0.5,
  lapseStrengthMultiplier:0.3,
  relearningStrengthMultiplier:1.2,
  relearningMaxStrengthHours:72,
  masteredThresholdHours:24*30,
  maxStrengthHours:24*90,
  targetRetention:0.9
});
const LEGACY_STRENGTH_HOURS = Object.freeze([1,6,12,24,48,96,168]);
const CSV_HEADER_FIELDS = new Map([
  ["id","id"],
  ["word","word"], ["meaning","meaning"], ["hint","hint"],
  ["scoretier","scoreTier"], ["targetscore","scoreTier"],
  ["difficulty","difficulty"], ["priority","priority"],
  ["partofspeech","partOfSpeech"], ["tags","tags"], ["level","level"]
]);
const STANDARD_CATALOG_URL = "./toeic-words.csv";
const STANDARD_CATALOG_FIELDS = ["id","word","meaning","hint","partOfSpeech","scoreTier","difficulty","priority","tags"];

let words = [];
let current = null;
let revealed = false;
let wordListPage = 1;
let pendingDeleteWordId = null;
let studyMode = null;
let dailyActivity = {date:"",newWords:0,reviewAnswers:0};
let standardCatalog = [];
let catalogById = new Map();

function now(){ return Date.now(); }

function calculateRetention(elapsedHours,memoryStrengthHours){
  const elapsed=Number(elapsedHours);
  const strength=Number(memoryStrengthHours);
  // 不正入力は正常な計算結果と区別できないが、安全な中立値として目標保持率を返す。
  if(!Number.isFinite(elapsed) || !Number.isFinite(strength) || strength<=0){
    return REVIEW_CONFIG.targetRetention;
  }
  return Math.pow(REVIEW_CONFIG.targetRetention,Math.max(0,elapsed)/strength);
}

function deriveLevel(memoryStrengthHours,learningStep){
  if(learningStep!==null) return 0;
  if(memoryStrengthHours===null || memoryStrengthHours===undefined) return 0;
  const strength=Number(memoryStrengthHours);
  if(!Number.isFinite(strength) || strength<=0) return 0;
  if(strength<24) return 1;
  if(strength<72) return 2;
  if(strength<168) return 3;
  if(strength<336) return 4;
  if(strength<720) return 5;
  return 6;
}

function calculateTimingRatio(elapsedHours,lastIntervalHours){
  const elapsed=Number(elapsedHours);
  const interval=Number(lastIntervalHours);
  if(!Number.isFinite(elapsed) || elapsed<0 || !Number.isFinite(interval) || interval<=0) return 1;
  return elapsed/interval;
}

function calculateElapsedHours(currentTimestamp,previousTimestamp){
  const current=Number(currentTimestamp);
  const previous=Number(previousTimestamp);
  // 回答前のlastが不正ならNaNを返し、calculateTimingRatio()で予定時刻付近として扱う。
  if(!Number.isFinite(current) || !Number.isFinite(previous) || previous<=0) return Number.NaN;
  return Math.max(0,(current-previous)/(60*60*1000));
}

function calculateGoodGrowthFactor(timingRatio){
  const ratio=Number(timingRatio);
  if(!Number.isFinite(ratio)) return REVIEW_CONFIG.goodOnTimeMultiplier;
  if(ratio<0.75) return REVIEW_CONFIG.goodEarlyMultiplier;
  if(ratio<=1.25) return REVIEW_CONFIG.goodOnTimeMultiplier;
  return REVIEW_CONFIG.goodLateMultiplier;
}

function calculateReviewSchedule({rating,memoryStrengthHours,elapsedHours,lastIntervalHours}){
  const parsedStrength=Number(memoryStrengthHours);
  const currentStrength=Number.isFinite(parsedStrength) && parsedStrength>0
    ? parsedStrength
    : REVIEW_CONFIG.initialReviewStrengthHours;

  if(rating==="again"){
    const strength=Math.max(1,currentStrength*REVIEW_CONFIG.lapseStrengthMultiplier);
    return {
      memoryStrengthHours:strength,
      nextIntervalHours:REVIEW_CONFIG.learningAgainMinutes/60,
      status:WORD_STATUS.LEARNING,
      learningStep:0
    };
  }

  if(rating==="hard"){
    const strength=Math.min(
      currentStrength*REVIEW_CONFIG.hardStrengthMultiplier,
      REVIEW_CONFIG.maxStrengthHours
    );
    return {
      memoryStrengthHours:strength,
      nextIntervalHours:Math.max(strength*REVIEW_CONFIG.hardIntervalMultiplier,1),
      status:WORD_STATUS.REVIEW,
      learningStep:null
    };
  }

  if(rating==="good"){
    const timingRatio=calculateTimingRatio(elapsedHours,lastIntervalHours);
    const growthFactor=calculateGoodGrowthFactor(timingRatio);
    const strength=Math.min(currentStrength*growthFactor,REVIEW_CONFIG.maxStrengthHours);
    return {
      memoryStrengthHours:strength,
      nextIntervalHours:strength,
      status:strength>=REVIEW_CONFIG.masteredThresholdHours
        ? WORD_STATUS.MASTERED
        : WORD_STATUS.REVIEW,
      learningStep:null,
      timingRatio,
      growthFactor
    };
  }

  return null;
}

function calculateLearningSchedule({status,learningStep,rating,memoryStrengthHours,lapses}){
  const parsedStrength=Number(memoryStrengthHours);
  const currentStrength=Number.isFinite(parsedStrength) && parsedStrength>0
    ? parsedStrength
    : null;
  const isUnseen=status===WORD_STATUS.UNSEEN;
  if(!isUnseen && status!==WORD_STATUS.LEARNING) return null;

  if(isUnseen || learningStep===0){
    if(rating==="again"){
      return {
        memoryStrengthHours:Math.max(currentStrength??1,1),
        learningStep:0,
        status:WORD_STATUS.LEARNING,
        nextIntervalHours:REVIEW_CONFIG.learningAgainMinutes/60
      };
    }
    if(rating==="hard" || rating==="good"){
      return {
        memoryStrengthHours:Math.max(currentStrength??1,6),
        learningStep:1,
        status:WORD_STATUS.LEARNING,
        nextIntervalHours:(rating==="hard"
          ? REVIEW_CONFIG.learningHardMinutes
          : REVIEW_CONFIG.learningGoodMinutes)/60
      };
    }
    return null;
  }

  if(learningStep===1){
    if(rating==="again"){
      return {
        memoryStrengthHours:Math.max(currentStrength??1,1),
        learningStep:0,
        status:WORD_STATUS.LEARNING,
        nextIntervalHours:REVIEW_CONFIG.learningAgainMinutes/60
      };
    }
    if(rating==="hard"){
      return {
        memoryStrengthHours:currentStrength??6,
        learningStep:1,
        status:WORD_STATUS.LEARNING,
        nextIntervalHours:REVIEW_CONFIG.learningStepOneHardMinutes/60
      };
    }
    if(rating==="good"){
      const strength=(Number(lapses)||0)>0
        ? Math.min(
          REVIEW_CONFIG.relearningMaxStrengthHours,
          Math.max(
            REVIEW_CONFIG.initialReviewStrengthHours,
            (currentStrength??REVIEW_CONFIG.initialReviewStrengthHours)*REVIEW_CONFIG.relearningStrengthMultiplier
          )
        )
        : Math.max(currentStrength??0,REVIEW_CONFIG.initialReviewStrengthHours);
      return {
        memoryStrengthHours:strength,
        learningStep:null,
        status:WORD_STATUS.REVIEW,
        nextIntervalHours:strength
      };
    }
  }

  return null;
}

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

function migrateReviewSchedule(entry){
  let migrated=false;
  const hasOwn=key=>Object.prototype.hasOwnProperty.call(entry,key);
  const last=Number(entry.last);
  const next=Number(entry.next);
  const storedIntervalHours=Number.isFinite(last) && Number.isFinite(next) && next>last
    ? (next-last)/(60*60*1000)
    : null;

  if(!hasOwn("memoryStrengthHours")){
    const legacyLevel=Number(entry.level);
    const legacyStrength=Number.isInteger(legacyLevel) && LEGACY_STRENGTH_HOURS[legacyLevel]!==undefined
      ? LEGACY_STRENGTH_HOURS[legacyLevel]
      : null;
    const statusStrength=entry.status===WORD_STATUS.UNSEEN
      ? null
      : entry.status===WORD_STATUS.LEARNING
        ? 6
        : REVIEW_CONFIG.initialReviewStrengthHours;
    entry.memoryStrengthHours=entry.status===WORD_STATUS.UNSEEN
      ? null
      : storedIntervalHours??legacyStrength??statusStrength;
    migrated=true;
  }
  if(!hasOwn("learningStep")){
    entry.learningStep=entry.status===WORD_STATUS.LEARNING
      ? (storedIntervalHours===null || storedIntervalHours<=0.5 ? 0 : 1)
      : null;
    migrated=true;
  }
  if(!hasOwn("lapses")){
    entry.lapses=0;
    migrated=true;
  }
  if(!hasOwn("lastRating")){
    entry.lastRating=null;
    migrated=true;
  }
  if(!hasOwn("lastIntervalHours")){
    entry.lastIntervalHours=storedIntervalHours;
    migrated=true;
  }
  if(!hasOwn("scheduleVersion")){
    entry.scheduleVersion=REVIEW_CONFIG.scheduleVersion;
    migrated=true;
  }
  return migrated;
}

function loadDailyActivity(){
  const saved=readStoredJsonSafely(DAILY_KEY,{});
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

function rebuildCatalogIndex(){
  catalogById=new Map(standardCatalog.map(entry=>[entry.id,entry]));
}

function parseStoredJson(raw,key,fallback){
  if(raw===null) return fallback;
  try{
    return JSON.parse(raw);
  } catch(error){
    throw new Error(`${key}の保存データを解析できません。`,{cause:error});
  }
}

function readStoredJsonSafely(key,fallback){
  try{
    return parseStoredJson(localStorage.getItem(key),key,fallback);
  } catch(error){
    console.error(error);
    return fallback;
  }
}

function mergeProgressRecords(standardProgress={},customProgress={}){
  const statusOrder={
    [WORD_STATUS.UNSEEN]:0,
    [WORD_STATUS.LEARNING]:1,
    [WORD_STATUS.REVIEW]:2,
    [WORD_STATUS.MASTERED]:3
  };
  const standardStatus=standardProgress.status||WORD_STATUS.UNSEEN;
  const customStatus=customProgress.status||WORD_STATUS.UNSEEN;
  const status=(statusOrder[customStatus]||0)>(statusOrder[standardStatus]||0) ? customStatus : standardStatus;
  const positiveFirstLearned=[Number(standardProgress.firstLearnedAt)||0,Number(customProgress.firstLearnedAt)||0].filter(Boolean);
  const positiveNext=[Number(standardProgress.next)||0,Number(customProgress.next)||0].filter(Boolean);
  const standardToday=standardProgress.today||"";
  const customToday=customProgress.today||"";
  const today=standardToday>=customToday ? standardToday : customToday;
  const todayCount=standardToday===customToday
    ? (Number(standardProgress.todayCount)||0)+(Number(customProgress.todayCount)||0)
    : today===customToday ? Number(customProgress.todayCount)||0 : Number(standardProgress.todayCount)||0;
  const memos=[standardProgress.memo,customProgress.memo].map(value=>String(value||"").trim()).filter(Boolean);
  const scheduleSource=(Number(customProgress.last)||0)>(Number(standardProgress.last)||0)
    ? customProgress
    : standardProgress;
  return {
    ...standardProgress,
    ...customProgress,
    status,
    level:Math.max(Number(standardProgress.level)||0,Number(customProgress.level)||0),
    correct:(Number(standardProgress.correct)||0)+(Number(customProgress.correct)||0),
    wrong:(Number(standardProgress.wrong)||0)+(Number(customProgress.wrong)||0),
    next:status===WORD_STATUS.UNSEEN ? 0 : positiveNext.length ? Math.min(...positiveNext) : 0,
    seen:(Number(standardProgress.seen)||0)+(Number(customProgress.seen)||0),
    last:Math.max(Number(standardProgress.last)||0,Number(customProgress.last)||0),
    firstLearnedAt:positiveFirstLearned.length ? Math.min(...positiveFirstLearned) : 0,
    today,
    todayCount,
    memo:[...new Set(memos)].join("\n---\n"),
    memoryStrengthHours:scheduleSource.memoryStrengthHours,
    learningStep:scheduleSource.learningStep,
    lapses:(Number(standardProgress.lapses)||0)+(Number(customProgress.lapses)||0),
    lastRating:scheduleSource.lastRating,
    lastIntervalHours:scheduleSource.lastIntervalHours,
    scheduleVersion:scheduleSource.scheduleVersion
  };
}

function mergeCatalogOverrides(migratedOverride,existingOverride){
  if(!migratedOverride) return existingOverride||null;
  if(!existingOverride) return migratedOverride;
  return {
    ...migratedOverride,
    ...existingOverride,
    learningProfile:{...(migratedOverride.learningProfile||{}),...(existingOverride.learningProfile||{})},
    tags:Array.isArray(existingOverride.tags) ? existingOverride.tags : migratedOverride.tags
  };
}

function customContentForMigration(entry,storedOverride){
  const base=entry.learningProfile ? entry : runtimeContent(entry);
  return storedOverride ? mergeCatalogContent(base,storedOverride) : base;
}

function restoreStorageSnapshot(snapshot){
  for(const [key,value] of Object.entries(snapshot)){
    if(value===null) localStorage.removeItem(key);
    else localStorage.setItem(key,value);
  }
}

function migrateCustomWordsToStandardCatalog(){
  if(localStorage.getItem(CATALOG_CSV_MIGRATED_KEY)==="1") return {alreadyMigrated:true};
  const protectedKeys=[PROGRESS_KEY,CUSTOM_WORDS_KEY,CATALOG_OVERRIDES_KEY,HIDDEN_CATALOG_KEY,LS_KEY];
  const snapshot=Object.fromEntries(protectedKeys.map(key=>[key,localStorage.getItem(key)]));
  try{
    if(localStorage.getItem(CATALOG_CSV_BACKUP_KEY)===null){
      localStorage.setItem(CATALOG_CSV_BACKUP_KEY,JSON.stringify({version:1,createdAt:new Date().toISOString(),values:snapshot}));
    }
    const progress=parseStoredJson(snapshot[PROGRESS_KEY],PROGRESS_KEY,{});
    const custom=parseStoredJson(snapshot[CUSTOM_WORDS_KEY],CUSTOM_WORDS_KEY,[]);
    const overrides=parseStoredJson(snapshot[CATALOG_OVERRIDES_KEY],CATALOG_OVERRIDES_KEY,{});
    const hidden=parseStoredJson(snapshot[HIDDEN_CATALOG_KEY],HIDDEN_CATALOG_KEY,[]);
    if(!progress || Array.isArray(progress) || typeof progress!=="object") throw new Error(`${PROGRESS_KEY}の形式が不正です。`);
    if(!Array.isArray(custom)) throw new Error(`${CUSTOM_WORDS_KEY}の形式が不正です。`);
    if(!overrides || Array.isArray(overrides) || typeof overrides!=="object") throw new Error(`${CATALOG_OVERRIDES_KEY}の形式が不正です。`);
    if(!Array.isArray(hidden)) throw new Error(`${HIDDEN_CATALOG_KEY}の形式が不正です。`);

    const standardByWord=new Map();
    for(const entry of standardCatalog){
      const key=normalizeWord(entry.word);
      if(!standardByWord.has(key)) standardByWord.set(key,[]);
      standardByWord.get(key).push(entry);
    }
    const customByWord=new Map();
    for(const entry of custom){
      const key=normalizeWord(entry.word);
      if(!customByWord.has(key)) customByWord.set(key,[]);
      customByWord.get(key).push(entry);
    }

    const nextProgress={...progress};
    const nextOverrides={...overrides};
    const nextHidden=new Set(hidden);
    const migratedIds=new Set();
    const warnings=[];
    const report={migratedWords:0,migratedProgress:0,migratedOverrides:0,remainingCustom:0,skippedAmbiguous:0,errors:0};

    for(const [wordKey,customEntries] of customByWord){
      const standardEntries=standardByWord.get(wordKey)||[];
      if(!standardEntries.length) continue;
      if(customEntries.length!==1 || standardEntries.length!==1){
        report.skippedAmbiguous+=customEntries.length;
        warnings.push({word:wordKey,customCount:customEntries.length,standardCount:standardEntries.length,reason:"同じ正規化wordが複数あるため自動移行しませんでした。"});
        continue;
      }
      const customEntry=customEntries[0];
      const standardEntry=standardEntries[0];
      if(!customEntry.id) {
        report.skippedAmbiguous++;
        warnings.push({word:wordKey,reason:"カスタム単語にIDがないため自動移行しませんでした。"});
        continue;
      }
      const oldId=customEntry.id;
      const newId=standardEntry.id;
      if(nextProgress[oldId]){
        nextProgress[newId]=mergeProgressRecords(nextProgress[newId],nextProgress[oldId]);
        delete nextProgress[oldId];
        report.migratedProgress++;
      }
      const customContent=customContentForMigration(customEntry,nextOverrides[oldId]);
      const migratedOverride=createCatalogOverride(runtimeWord(customContent),standardEntry);
      const combinedOverride=mergeCatalogOverrides(migratedOverride,nextOverrides[newId]);
      if(combinedOverride) nextOverrides[newId]=combinedOverride;
      else delete nextOverrides[newId];
      if(migratedOverride) report.migratedOverrides++;
      delete nextOverrides[oldId];
      if(nextHidden.has(oldId)){
        nextHidden.delete(oldId);
        nextHidden.add(newId);
      }
      migratedIds.add(oldId);
      report.migratedWords++;
    }

    const nextCustom=custom.filter(entry=>!migratedIds.has(entry.id));
    report.remainingCustom=nextCustom.length;
    if(nextCustom.length+report.migratedWords!==custom.length) throw new Error("移行後のカスタム単語件数が一致しません。");
    for(const id of migratedIds){
      if(nextCustom.some(entry=>entry.id===id)) throw new Error(`移行済みID ${id} がカスタム単語に残っています。`);
    }
    const nextValues={
      [PROGRESS_KEY]:JSON.stringify(nextProgress),
      [CUSTOM_WORDS_KEY]:JSON.stringify(nextCustom),
      [CATALOG_OVERRIDES_KEY]:JSON.stringify(nextOverrides),
      [HIDDEN_CATALOG_KEY]:JSON.stringify([...nextHidden])
    };
    Object.values(nextValues).forEach(value=>JSON.parse(value));
    for(const [key,value] of Object.entries(nextValues)) localStorage.setItem(key,value);
    localStorage.setItem(CATALOG_CSV_MIGRATED_KEY,"1");
    if(warnings.length) console.warn("標準CSVへの自動移行をスキップした単語があります。",warnings);
    console.info("標準CSVカタログへのLocalStorage移行が完了しました。",report);
    return report;
  } catch(error){
    try{
      restoreStorageSnapshot(snapshot);
      localStorage.removeItem(CATALOG_CSV_MIGRATED_KEY);
    } catch(restoreError){
      console.error("LocalStorage移行失敗後の復元にも失敗しました。バックアップを確認してください。",restoreError);
    }
    console.error("標準CSVカタログへのLocalStorage移行に失敗しました。元データを維持して起動します。",error);
    return {migratedWords:0,migratedProgress:0,migratedOverrides:0,remainingCustom:0,skippedAmbiguous:0,errors:1,error};
  }
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
    memo:entry.memo||"",
    memoryStrengthHours:entry.memoryStrengthHours??null,
    learningStep:entry.status!==WORD_STATUS.UNSEEN && (entry.learningStep===0 || entry.learningStep===1)
      ? entry.learningStep
      : null,
    lapses:Number(entry.lapses)||0,
    lastRating:entry.lastRating??null,
    lastIntervalHours:entry.lastIntervalHours??null,
    scheduleVersion:entry.scheduleVersion??REVIEW_CONFIG.scheduleVersion
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
    memo:progress.memo||"",
    memoryStrengthHours:progress.memoryStrengthHours,
    learningStep:progress.learningStep,
    lapses:progress.lapses,
    lastRating:progress.lastRating,
    lastIntervalHours:progress.lastIntervalHours,
    scheduleVersion:progress.scheduleVersion
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
  const legacy=parseStoredJson(raw,LS_KEY,[]);
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
  // 主要データの破損を空データとして上書きしないよう、解析失敗は初期化エラーとして安全停止する。
  const progress=parseStoredJson(localStorage.getItem(PROGRESS_KEY),PROGRESS_KEY,{});
  const custom=parseStoredJson(localStorage.getItem(CUSTOM_WORDS_KEY),CUSTOM_WORDS_KEY,[]);
  const overrides=parseStoredJson(localStorage.getItem(CATALOG_OVERRIDES_KEY),CATALOG_OVERRIDES_KEY,{});
  const hidden=new Set(parseStoredJson(localStorage.getItem(HIDDEN_CATALOG_KEY),HIDDEN_CATALOG_KEY,[]));
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
  words.forEach(entry=>{
    if(migrateWordStatus(entry)) migrated=true;
    if(migrateReviewSchedule(entry)) migrated=true;
  });
  const settings = readStoredJsonSafely(SETTINGS_KEY,{});
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

function calculateOverdueRatio(entry,currentTimestamp=now()){
  const next=Number(entry.next);
  const interval=Number(entry.lastIntervalHours);
  const current=Number(currentTimestamp);
  if(entry.next===null || entry.next===undefined || entry.next==="" || !Number.isFinite(next) ||
    !Number.isFinite(interval) || interval<=0 || !Number.isFinite(current)) return null;
  const overdueHours=Math.max(0,(current-next)/(60*60*1000));
  return overdueHours/interval;
}

function compareDueWords(a,b,currentTimestamp=now()){
  const order={[WORD_STATUS.LEARNING]:0,[WORD_STATUS.REVIEW]:1,[WORD_STATUS.MASTERED]:2};
  const statusDifference=(order[a.status]??3)-(order[b.status]??3);
  if(statusDifference) return statusDifference;

  const aRatio=calculateOverdueRatio(a,currentTimestamp);
  const bRatio=calculateOverdueRatio(b,currentTimestamp);
  // 両方の期限超過率を計算できる場合のみ比率を比較する。どちらかが不正ならnextが古い順、
  // nextでも比較できない場合は0を返し、sortDueWords()で元の配列順を維持する。
  if(aRatio!==null && bRatio!==null && aRatio!==bRatio) return bRatio-aRatio;

  const aNext=Number(a.next);
  const bNext=Number(b.next);
  const aNextIsValid=a.next!==null && a.next!==undefined && a.next!=="" && Number.isFinite(aNext);
  const bNextIsValid=b.next!==null && b.next!==undefined && b.next!=="" && Number.isFinite(bNext);
  if(aNextIsValid && bNextIsValid && aNext!==bNext) return aNext-bNext;
  return 0;
}

function sortDueWords(entries,currentTimestamp=now()){
  return entries
    .map((entry,index)=>({entry,index}))
    .sort((a,b)=>compareDueWords(a.entry,b.entry,currentTimestamp) || a.index-b.index)
    .map(item=>item.entry);
}

function getReviewScheduleCounts(entries,currentTimestamp=now()){
  const current=Number(currentTimestamp);
  if(!Number.isFinite(current)) return {dueNow:0,laterToday:0,tomorrow:0,withinSevenDays:0};

  const currentDate=new Date(current);
  const year=currentDate.getFullYear();
  const month=currentDate.getMonth();
  const date=currentDate.getDate();
  const todayStart=new Date(year,month,date).getTime();
  const tomorrowStart=new Date(year,month,date+1).getTime();
  const dayAfterTomorrowStart=new Date(year,month,date+2).getTime();
  const sevenDaysEnd=new Date(year,month,date+7).getTime()-1;
  const todayEnd=tomorrowStart-1;
  const tomorrowEnd=dayAfterTomorrowStart-1;
  const result={dueNow:0,laterToday:0,tomorrow:0,withinSevenDays:0};

  for(const entry of entries){
    if(entry.status===WORD_STATUS.UNSEEN) continue;
    // nextが0または欠損した学習済み単語は、壊れた復習予定を次回回答で修復できるよう、
    // 既存互換として即時復習対象に含める。ただし将来予定の集計には含めない。
    if((entry.next||0)<=current) result.dueNow++;

    const next=Number(entry.next);
    if(!Number.isFinite(next) || next<=0) continue;
    if(next>current && next<=todayEnd) result.laterToday++;
    if(next>=tomorrowStart && next<=tomorrowEnd) result.tomorrow++;
    if(next>=todayStart && next<=sevenDaysEnd) result.withinSevenDays++;
  }
  return result;
}

function formatNextReview(timestamp,currentTimestamp=now()){
  const target=Number(timestamp);
  const current=Number(currentTimestamp);
  if(!Number.isFinite(target) || target<=0 || !Number.isFinite(current)) return "";

  const difference=target-current;
  if(difference>0 && difference<60*60*1000){
    return `${Math.max(1,Math.ceil(difference/(60*1000)))}分後`;
  }

  const targetDate=new Date(target);
  const currentDate=new Date(current);
  const tomorrow=new Date(currentDate.getFullYear(),currentDate.getMonth(),currentDate.getDate()+1);
  const dayAfterTomorrow=new Date(currentDate.getFullYear(),currentDate.getMonth(),currentDate.getDate()+2);
  const isSameDay=targetDate.getFullYear()===currentDate.getFullYear() &&
    targetDate.getMonth()===currentDate.getMonth() && targetDate.getDate()===currentDate.getDate();
  const time=`${targetDate.getHours()}:${String(targetDate.getMinutes()).padStart(2,"0")}`;
  if(difference>=0 && difference<24*60*60*1000 && isSameDay) return `今日 ${time}`;
  if(target>=tomorrow.getTime() && target<dayAfterTomorrow.getTime()) return `明日 ${time}`;
  if(targetDate.getFullYear()!==currentDate.getFullYear()){
    return `${targetDate.getFullYear()}年${targetDate.getMonth()+1}月${targetDate.getDate()}日`;
  }
  return `${targetDate.getMonth()+1}月${targetDate.getDate()}日`;
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
    candidates.splice(0,candidates.length,...sortDueWords(candidates));
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
  const answeredWord=current.word;
  const previousLast=Number(current.last);
  const elapsedHours=calculateElapsedHours(t,previousLast);
  const isNew=current.status===WORD_STATUS.UNSEEN;
  const isReviewPhase=current.status===WORD_STATUS.REVIEW || current.status===WORD_STATUS.MASTERED;
  const rating=type==="bad" ? "again" : type==="mid" ? "hard" : "good";
  const learningSchedule=(isNew || (current.status===WORD_STATUS.LEARNING && (current.learningStep===0 || current.learningStep===1)))
    ? calculateLearningSchedule({
      status:current.status,
      learningStep:current.learningStep,
      rating,
      memoryStrengthHours:current.memoryStrengthHours,
      lapses:current.lapses
    })
    : null;
  const reviewSchedule=isReviewPhase
    ? calculateReviewSchedule({
      rating,
      memoryStrengthHours:current.memoryStrengthHours,
      elapsedHours,
      lastIntervalHours:current.lastIntervalHours
    })
    : null;
  if(isNew){
    dailyActivity.newWords++;
    if(!current.firstLearnedAt) current.firstLearnedAt=t;
  } else {
    dailyActivity.reviewAnswers++;
  }
  current.seen = (current.seen||0)+1;
  const td = todayKey();
  current.today = current.today===td ? td : td;
  current.todayCount = (current.todayCount||0)+1;
  if(rating==="again") current.wrong=(current.wrong||0)+1;
  if(rating==="good") current.correct=(current.correct||0)+1;

  if(learningSchedule){
    current.memoryStrengthHours=learningSchedule.memoryStrengthHours;
    current.learningStep=learningSchedule.learningStep;
    current.status=learningSchedule.status;
    current.lastIntervalHours=learningSchedule.nextIntervalHours;
    current.lastRating=rating;
    current.scheduleVersion=REVIEW_CONFIG.scheduleVersion;
    current.level=deriveLevel(current.memoryStrengthHours,current.learningStep);
    current.next=t+learningSchedule.nextIntervalHours*60*60*1000;
  } else if(reviewSchedule){
    current.memoryStrengthHours=reviewSchedule.memoryStrengthHours;
    current.learningStep=reviewSchedule.learningStep;
    current.status=reviewSchedule.status;
    if(rating==="again") current.lapses=(current.lapses||0)+1;
    current.lastIntervalHours=reviewSchedule.nextIntervalHours;
    current.lastRating=rating;
    current.scheduleVersion=REVIEW_CONFIG.scheduleVersion;
    current.level=deriveLevel(current.memoryStrengthHours,current.learningStep);
    current.next=t+reviewSchedule.nextIntervalHours*60*60*1000;
  } else if(type==="bad"){
    current.level=Math.max(0,(current.level||0)-1);
    current.next=t+10*60*1000;
    current.status=WORD_STATUS.LEARNING;
  } else if(type==="mid"){
    current.next=t+60*60*1000;
    current.status=(isNew || current.status===WORD_STATUS.LEARNING)
      ? WORD_STATUS.LEARNING
      : WORD_STATUS.REVIEW;
  } else {
    current.level=Math.min(6,(current.level||0)+1);
    const intervals=[2,6,12,24,48,96,168]; // hours
    current.next=t+intervals[current.level]*60*60*1000;
    current.status=current.level>=4 ? WORD_STATUS.MASTERED : WORD_STATUS.REVIEW;
  }
  nextReviewNotice.textContent=`${answeredWord} の次回復習：${formatNextReview(current.next,t)}`;
  current.last=t;
  saveDailyActivity();
  save();
  chooseNext();
}

function refreshStats(){
  ensureCurrentDailyActivity();
  const reviewScheduleCounts=getReviewScheduleCounts(words);
  const due=reviewScheduleCounts.dueNow;
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
  refreshStudyPlan(dateInfo,due,counts,reviewScheduleCounts);
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

function refreshStudyPlan(dateInfo,due,counts,reviewScheduleCounts){
  const score=Number(targetScore.value)||DEFAULT_TARGET_SCORE;
  const target=VOCAB_TARGETS[score];
  const studied=counts.learning+counts.review+counts.mastered;
  const remaining=Math.max(0,target-studied);
  const dailyNewEstimate=dateInfo.days>0 ? Math.ceil(remaining/dateInfo.days) : 0;
  const reviewEstimate=reviewScheduleCounts.dueNow+reviewScheduleCounts.laterToday;
  const todayNewGoal=dateInfo.days>0 ? Math.min(dailyNewEstimate,counts.unseen) : 0;
  const todayReviewGoal=reviewEstimate;
  const overallPercent=target>0 ? Math.min(100,studied/target*100) : 0;

  vocabTarget.textContent=`約${target.toLocaleString("ja-JP")}語`;
  registeredPlanCount.textContent=`${words.length.toLocaleString("ja-JP")}語`;
  studiedPlanCount.textContent=`${studied.toLocaleString("ja-JP")}語`;
  remainingNew.textContent=`${remaining.toLocaleString("ja-JP")}語`;
  planDaysLeft.textContent=`${dateInfo.days.toLocaleString("ja-JP")}日`;
  dailyNew.textContent=`${dailyNewEstimate.toLocaleString("ja-JP")}語`;
  dailyReview.textContent=`${reviewEstimate.toLocaleString("ja-JP")}語`;
  todayNewPlanText.textContent=`${dailyActivity.newWords.toLocaleString("ja-JP")}語 / ${todayNewGoal.toLocaleString("ja-JP")}語`;
  todayReviewPlanText.textContent=`${dailyActivity.reviewAnswers.toLocaleString("ja-JP")}回 / 予定${todayReviewGoal.toLocaleString("ja-JP")}語`;
  overallPlanText.textContent=`${studied.toLocaleString("ja-JP")}語 / ${target.toLocaleString("ja-JP")}語（${Math.round(overallPercent)}%）`;
  setProgressBar(todayNewBar,dailyActivity.newWords,todayNewGoal);
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
    warnings.push(`1日あたり新規${dailyNewEstimate.toLocaleString("ja-JP")}語・復習予定${reviewEstimate.toLocaleString("ja-JP")}語の計画です。継続が難しい可能性があるため、試験日や目標点数を見直してください。`);
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
  const value=Number(timestamp);
  if(!Number.isFinite(value) || value<=0) return "";
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) return "";
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  if(!Number.isFinite(local.getTime())) return "";
  try{
    return local.toISOString().slice(0,16);
  } catch(error){
    console.warn("次回復習日時を編集画面用に変換できませんでした。",error);
    return "";
  }
}

function resetWordProgress(entry){
  Object.assign(entry,{
    status:WORD_STATUS.UNSEEN,
    level:0,
    next:0,
    last:0,
    firstLearnedAt:0,
    seen:0,
    correct:0,
    wrong:0,
    memoryStrengthHours:null,
    learningStep:null,
    lapses:0,
    lastRating:null,
    lastIntervalHours:null,
    scheduleVersion:REVIEW_CONFIG.scheduleVersion
  });
}

function setManualNextReview(entry,timestamp){
  entry.next=timestamp;
}

function openWordEditor(id){
  const entry=words.find(word=>word.id===id);
  if(!entry) return;
  editWordId.value=entry.id;
  editWord.value=entry.word;
  editMeaning.value=entry.meaning;
  editHint.value=entry.hint||"";
  editLevel.value=deriveLevel(entry.memoryStrengthHours,entry.learningStep);
  editStatus.value=getWordStatus(entry).label.replace("復習対象","復習中");
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
  const knownIds=new Set();
  for(const record of parsed.records.slice(1)){
    const idValue=csvValue(record.cells,map,"id");
    const wordValue=csvValue(record.cells,map,"word");
    const meaningValue=csvValue(record.cells,map,"meaning");
    const scoreTierValue=csvValue(record.cells,map,"scoreTier");
    const difficultyValue=csvValue(record.cells,map,"difficulty");
    const priorityValue=csvValue(record.cells,map,"priority");
    let reason="";
    if(record.invalidLine) reason="値の途中に不正なダブルクォートがあります。";
    else if(!idValue) reason="idが空です。";
    else if(!/^[A-Za-z0-9_-]+$/.test(idValue)) reason="idに使用できない文字が含まれています。";
    else if(knownIds.has(idValue)) reason="同じidが標準CSV内で重複しています。";
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
    knownIds.add(idValue);
    knownWords.add(normalized);
    catalog.push({
      id:idValue,
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
newStartBtn.addEventListener("click",()=>{nextReviewNotice.textContent="";studyMode="new";chooseNext();});
startBtn.addEventListener("click",()=>{nextReviewNotice.textContent="";studyMode="review";chooseNext();});
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
resetWordProgressBtn.addEventListener("click",()=>{
  const entry=words.find(word=>word.id===editWordId.value);
  if(!entry) return;
  const confirmed=confirm("この単語の学習履歴をリセットして未学習に戻しますか？\n単語データやメモは削除されません。");
  if(!confirmed) return;
  const resettingCurrent=Boolean(current && current.id===entry.id);
  resetWordProgress(entry);
  save();
  closeModal(editWordDialog);
  if(resettingCurrent && studyMode) chooseNext();
  else refreshStats();
});
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
  const updatedPriority=editPriority.value==="" ? undefined : Number(editPriority.value);
  if(updatedPriority!==undefined && (!Number.isInteger(updatedPriority) || updatedPriority<1 || updatedPriority>5)){
    editWordError.textContent="優先度は1〜5の整数で指定してください。";
    return;
  }
  const updatedNext=editNext.value ? new Date(editNext.value).getTime() : 0;
  if(!Number.isFinite(updatedNext)){
    editWordError.textContent="次回復習日時が不正です。";
    return;
  }

  entry.word=updatedWord;
  entry.meaning=updatedMeaning;
  entry.hint=editHint.value.trim();
  setManualNextReview(entry,updatedNext);
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
retryCatalogBtn.addEventListener("click",initializeApp);

resetAllBtn.addEventListener("click",()=>{
  if(!confirm("単語と学習履歴を全部消す？")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(PROGRESS_KEY);
  localStorage.removeItem(CUSTOM_WORDS_KEY);
  localStorage.removeItem(CATALOG_OVERRIDES_KEY);
  localStorage.removeItem(HIDDEN_CATALOG_KEY);
  localStorage.removeItem(CATALOG_CSV_MIGRATED_KEY);
  localStorage.removeItem(CATALOG_CSV_BACKUP_KEY);
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
  if(isLoading){
    catalogLoadStatus.className="small";
    catalogLoadStatus.textContent="標準単語データを読み込んでいます…";
  }
}

async function initializeApp(){
  setAppLoading(true);
  retryCatalogBtn.hidden=true;
  retryCatalogBtn.disabled=true;
  try{
    const result=await loadStandardCatalog();
    standardCatalog=result.catalog;
    catalogLoadStatus.textContent=`標準単語 ${standardCatalog.length.toLocaleString("ja-JP")}語を読み込みました。`;
    rebuildCatalogIndex();
    const migrationReport=migrateCustomWordsToStandardCatalog();
    if(migrationReport.errors) throw new Error("LocalStorageの移行に失敗しました。元データを保護するため初期化を停止します。");
    load();
    setAppLoading(false);
    document.documentElement.dataset.catalogSource="csv";
  } catch(error){
    standardCatalog=[];
    rebuildCatalogIndex();
    words=[];
    current=null;
    setAppLoading(true);
    resetAllBtn.disabled=false;
    retryCatalogBtn.hidden=false;
    retryCatalogBtn.disabled=false;
    catalogLoadStatus.className="small catalog-load-error";
    catalogLoadStatus.textContent="単語データまたは保存データを読み込めませんでした。内容を確認して、再読み込みしてください。";
    document.documentElement.dataset.catalogSource="error";
    console.error("標準単語CSVの読み込みまたはアプリ初期化に失敗しました。",error);
  }
}

initializeApp();
