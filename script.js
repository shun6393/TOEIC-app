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
const WORDS_PER_PAGE = 50;

let words = [];
let current = null;
let revealed = false;
let wordListPage = 1;
let pendingDeleteWordId = null;

function now(){ return Date.now(); }
function todayKey(){ return new Date().toISOString().slice(0,10); }

function load(){
  const raw = localStorage.getItem(LS_KEY);
  if(raw){
    words = JSON.parse(raw);
  } else {
    words = STARTER_WORDS.map((entry,i)=>({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+i),
      word:entry.word, meaning:entry.meaning, hint:entry.hint||"",
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
  renderWordList();
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

function getWordStatus(entry){
  if((entry.seen||0)===0) return {label:"未学習", className:"status-unseen"};
  if((entry.level||0)>=4) return {label:"ほぼ定着", className:"status-mastered"};
  return {label:"学習中", className:"status-learning"};
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
  editSeen.value=entry.seen||0;
  editCorrect.value=entry.correct||0;
  editWrong.value=entry.wrong||0;
  editNext.value=toDateTimeLocal(entry.next||0);
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

card.addEventListener("click", reveal);
startBtn.addEventListener("click", chooseNext);
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
  if(updatedCorrect+updatedWrong>updatedSeen){
    editWordError.textContent="学習回数は、正解回数と不正解回数の合計以上にしてください。";
    return;
  }

  entry.word=updatedWord;
  entry.meaning=updatedMeaning;
  entry.hint=editHint.value.trim();
  entry.level=Math.min(6,Math.max(0,Number(editLevel.value)||0));
  entry.seen=updatedSeen;
  entry.correct=updatedCorrect;
  entry.wrong=updatedWrong;
  entry.next=editNext.value ? new Date(editNext.value).getTime() : 0;
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
  STARTER_WORDS.forEach((entry,i)=>words.push({
    id:String(Date.now()+i),word:entry.word,meaning:entry.meaning,hint:entry.hint||"",
    level:0,correct:0,wrong:0,next:0,seen:0,last:0
  }));
  save(); chooseNext(); refreshStats();
});

load();
