const starterWords = [
["abandon","放棄する","abandon a plan"],
["acquire","獲得する","会社や技能を手に入れる"],
["additional","追加の","addの仲間"],
["adequate","十分な","必要量を満たす"],
["approximately","およそ","aboutと同じ感覚"],
["arrange","手配する、整える","予定や物を整える"],
["available","利用できる、空いている","人・物・時間に使う"],
["benefit","利益、恩恵","beneficialもセット"],
["confirm","確認する","予約確認で頻出"],
["conduct","実施する","conduct a survey"],
["consider","検討する","consider doing"],
["contract","契約","sign a contract"],
["convenient","便利な","場所や時間にも使う"],
["delay","遅らせる、遅延","flight delay"],
["deliver","配達する、届ける","deliveryの動詞"],
["department","部門、部署","sales department"],
["despite","〜にもかかわらず","後ろは名詞"],
["determine","決定する","determine whether"],
["effective","効果的な","effectは名詞"],
["employee","従業員","employerは雇用主"],
["ensure","確実にする","make sureに近い"],
["equipment","設備、機器","不可算名詞"],
["estimate","見積もる、見積もり","price estimate"],
["facility","施設、設備","複数形facilitiesも頻出"],
["frequently","頻繁に","oftenより硬め"],
["increase","増加する、増加","名詞と動詞"],
["indicate","示す","グラフ説明で頻出"],
["maintain","維持する","maintenanceもセット"],
["negotiate","交渉する","negotiate with"],
["notify","知らせる","notify A of B"],
["participate","参加する","participate in"],
["policy","方針、規定","company policy"],
["postpone","延期する","put offと同じ"],
["purchase","購入する、購入","buyより硬い"],
["require","必要とする","require A to do"],
["schedule","予定、予定を組む","発音はスケジュール"],
["submit","提出する","submit a report"],
["temporary","一時的な","temporary staff"],
["vacant","空いている","部屋・役職に使う"],
["verify","確認する、検証する","情報が正しいか確かめる"]
];

const LS_KEY = "toeic_cram_words_v1";
const SETTINGS_KEY = "toeic_cram_settings_v1";
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

let words = [];
let current = null;
let revealed = false;

function now(){ return Date.now(); }
function todayKey(){ return new Date().toISOString().slice(0,10); }

function load(){
  const raw = localStorage.getItem(LS_KEY);
  if(raw){
    words = JSON.parse(raw);
  } else {
    words = starterWords.map((w,i)=>({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+i),
      word:w[0], meaning:w[1], hint:w[2]||"",
      level:0, correct:0, wrong:0, next:0, seen:0, last:0
    }));
    save();
  }
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");
  examDate.value = settings.examDate || "2026-07-21";
  targetScore.value = VOCAB_TARGETS[settings.targetScore]
    ? settings.targetScore
    : DEFAULT_TARGET_SCORE;
  dailyGoal.value = settings.dailyGoal || 100;
  refreshStats();
}

function save(){
  localStorage.setItem(LS_KEY, JSON.stringify(words));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    examDate: examDate.value,
    targetScore: Number(targetScore.value) || DEFAULT_TARGET_SCORE,
    dailyGoal: Number(dailyGoal.value)||100
  }));
}

function dueWords(){
  const t = now();
  return words.filter(w => (w.next||0) <= t);
}

function chooseNext(){
  const due = dueWords();
  if(!due.length){
    current = null;
    word.textContent = "今すぐ復習する単語はなし";
    meaning.textContent = "";
    hint.textContent = "少し時間を置くか、新しい単語を追加してね。";
    meaning.style.display = "none";
    hint.style.display = "block";
    tapText.textContent = "";
    setButtons(false);
    refreshStats();
    return;
  }
  due.sort((a,b)=>{
    if((a.level||0)!==(b.level||0)) return (a.level||0)-(b.level||0);
    if((a.seen||0)!==(b.seen||0)) return (a.seen||0)-(b.seen||0);
    return Math.random()-.5;
  });
  current = due[0];
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
  const t = now();
  current.seen = (current.seen||0)+1;
  current.last = t;
  const td = todayKey();
  current.today = current.today===td ? td : td;
  current.todayCount = (current.todayCount||0)+1;

  if(type==="bad"){
    current.wrong=(current.wrong||0)+1;
    current.level=Math.max(0,(current.level||0)-1);
    current.next=t+10*60*1000;
  } else if(type==="mid"){
    current.next=t+60*60*1000;
  } else {
    current.correct=(current.correct||0)+1;
    current.level=Math.min(6,(current.level||0)+1);
    const intervals=[2,6,12,24,48,96,168]; // hours
    current.next=t+intervals[current.level]*60*60*1000;
  }
  save();
  chooseNext();
}

function refreshStats(){
  const td=todayKey();
  const today=words.reduce((s,w)=>s+(w.today===td?(w.todayCount||0):0),0);
  const due=dueWords().length;
  const mastered=words.filter(w=>(w.level||0)>=4).length;
  dueCount.textContent=due;
  todayCount.textContent=today;
  masteredCount.textContent=mastered;
  const exam = new Date(examDate.value+"T23:59:59");
  const days = Math.max(0, Math.ceil((exam-new Date())/86400000));
  daysLeft.textContent=days;
  const goal=Number(dailyGoal.value)||100;
  goalBar.style.width=Math.min(100,today/goal*100)+"%";
  goalText.textContent=`今日 ${today} / ${goal} 回回答`;
  refreshStudyPlan(days, due);
}

function refreshStudyPlan(days, due){
  const score=Number(targetScore.value)||DEFAULT_TARGET_SCORE;
  const target=VOCAB_TARGETS[score];
  const studied=words.filter(w=>(w.seen||0)>0).length;
  const remaining=Math.max(0,target-studied);
  const dailyNew=days>0 ? Math.ceil(remaining/days) : 0;
  const reviewEstimate=days>0
    ? Math.max(due,dailyNew*DAILY_REVIEW_MULTIPLIER)
    : 0;

  vocabTarget.textContent=`約${target.toLocaleString("ja-JP")}語`;
  remainingNew.textContent=`${remaining.toLocaleString("ja-JP")}語`;
  dailyNew.textContent=`${dailyNew.toLocaleString("ja-JP")}語`;
  dailyReview.textContent=`${reviewEstimate.toLocaleString("ja-JP")}回`;
  planNotice.textContent=days>0
    ? `学習済み ${studied.toLocaleString("ja-JP")}語を基準に計算しています。`
    : "試験日を未来の日付に設定すると学習計画を計算します。";
}

card.addEventListener("click", reveal);
startBtn.addEventListener("click", chooseNext);
badBtn.addEventListener("click",()=>answer("bad"));
midBtn.addEventListener("click",()=>answer("mid"));
goodBtn.addEventListener("click",()=>answer("good"));

examDate.addEventListener("change",()=>{save();refreshStats();});
targetScore.addEventListener("change",()=>{save();refreshStats();});
dailyGoal.addEventListener("change",()=>{save();refreshStats();});

resetTodayBtn.addEventListener("click",()=>{
  const td=todayKey();
  words.forEach(w=>{ if(w.today===td) w.todayCount=0; });
  save(); refreshStats();
});

addBtn.addEventListener("click",()=>{
  const lines=importBox.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  let added=0;
  for(const line of lines){
    const [w,m,...h]=line.split(",").map(x=>x.trim());
    if(!w||!m) continue;
    if(words.some(x=>x.word.toLowerCase()===w.toLowerCase())) continue;
    words.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()),
      word:w, meaning:m, hint:h.join(","),
      level:0, correct:0, wrong:0, next:0, seen:0, last:0
    });
    added++;
  }
  save(); refreshStats();
  alert(`${added}語追加したよ`);
  importBox.value="";
});

exportBtn.addEventListener("click",()=>{
  importBox.value=words.map(w=>[w.word,w.meaning,w.hint||""].join(",")).join("\n");
});

resetAllBtn.addEventListener("click",()=>{
  if(!confirm("単語と学習履歴を全部消す？")) return;
  localStorage.removeItem(LS_KEY);
  words=[];
  starterWords.forEach((w,i)=>words.push({
    id:String(Date.now()+i),word:w[0],meaning:w[1],hint:w[2]||"",
    level:0,correct:0,wrong:0,next:0,seen:0,last:0
  }));
  save(); chooseNext(); refreshStats();
});

load();
