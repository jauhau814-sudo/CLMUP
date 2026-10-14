/* CLNUP browser client. Server is the sole authority for identity and balances. */
let currentUser=null,allTasks=[],userTasks=[],selectedTask=null,completionTask=null;
let csrf='',taskCategory='all',mapCategory='all',ratingPeriod='all',tasksPage=1,taskTotal=0;
let photoContext='report',notificationType='reminders',searchTimer,taskRequest=0;
let mapView,pickerMap,pickerMarker,taskLayer;
let mapConfig={mapTileUrl:'',mapAttribution:''};
const uploads={},draftKeys={},coordinates={};
const $=id=>document.getElementById(id);
const value=id=>$(id).value.trim();
const publicScreens=new Set(['register-screen','login-screen','signup-screen','tasks-screen','map-screen','task-details-screen','help-screen','about-screen','rating-screen']);
const labels={easy:'Легко',medium:'Средне',hard:'Сложно',PENDING:'На проверке',ACTIVE:'Доступно',CLAIMED:'В работе',REVIEW:'Фотоотчёт на проверке',COMPLETED:'Принято',REJECTED:'Отклонено',CANCELLED:'Отменено',ACCEPTED:'Принято',in_progress:'В работе',review:'На проверке',completed:'Принято'};
function node(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function text(id,t){if($(id))$(id).textContent=t;}
function empty(element,message='Пока нет записей.'){element.replaceChildren(node('p','task-empty',message));}
function notify(message,error=false){const e=$('apiNotice');e.textContent=message;e.hidden=false;e.className=error?'api-notice error':'api-notice';if(!error)setTimeout(()=>e.hidden=true,6500);}
async function api(url,options={}){
 const method=options.method||'GET';
 if(method!=='GET'&&!csrf){const response=await fetch('/api/auth/csrf',{credentials:'same-origin'});const body=await response.json();if(!response.ok)throw Error(body.error?.message||'Не удалось начать сессию.');csrf=body.data.token;}
 const form=options.body instanceof FormData;
 const response=await fetch('/api'+url,{credentials:'same-origin',...options,headers:{...(form?{}:{'Content-Type':'application/json'}),...(method!=='GET'?{'X-CSRF-Token':csrf}:{}),...options.headers},body:options.body?form?options.body:JSON.stringify(options.body):undefined});
 const body=await response.json();
 if(!response.ok){if(response.status===401){currentUser=null;updateUser();}const details=body.error?.details?.map(d=>d.field+': '+d.message).join('\n');throw Error(details||body.error?.message||'Не удалось выполнить запрос.');}
 return body.data;
}
const activeActions=new Set();
async function action(key,callback){
 if(activeActions.has(key))return;
 activeActions.add(key);const buttons=[...document.querySelectorAll('button:not([disabled])')];buttons.forEach(b=>{b.disabled=true;b.setAttribute('aria-busy','true');});
 try{await callback();}catch(error){notify(error.message,true);}finally{activeActions.delete(key);buttons.forEach(b=>{b.disabled=false;b.removeAttribute('aria-busy');});}
}
function key(name){return draftKeys[name]??=crypto.randomUUID();}
function showSuccess(message){text('successMessage',message);$('successModal').style.display='flex';}
function closeModal(id){$(id).style.display='none';}
async function showScreen(id){
 if(!currentUser&&!publicScreens.has(id))id='login-screen';
 document.querySelectorAll('[id$="-screen"]').forEach(e=>e.style.display='none');
 $(id).style.display='block';document.body.dataset.screen=id;document.body.dataset.guest=currentUser?'false':'true';window.scrollTo(0,0);
 document.querySelectorAll('.nav-item').forEach(e=>e.classList.remove('nav-active'));
 const navIndex={'main-screen':0,'map-screen':1,'profile-screen':2}[id];if(navIndex!==undefined)document.querySelectorAll('.nav-item')[navIndex]?.classList.add('nav-active');
 try{
  if(id==='tasks-screen')await loadTasks();
  if(id==='map-screen')await loadMap();
  if(['main-screen','profile-screen','balance-screen','active-tasks-screen','settings-screen'].includes(id)&&currentUser)await refresh();
  if(id==='rating-screen')await loadRating();
 }catch(e){notify(e.message,true);}
}
function updateUser(){
 document.querySelectorAll('.user-avatar').forEach(e=>e.textContent=currentUser?(currentUser.firstName[0]+currentUser.lastName[0]):'↗');
 document.querySelectorAll('[data-auth-only]').forEach(e=>e.hidden=!currentUser);
 $('moderationLink').hidden=!currentUser||currentUser.role==='MEMBER';
 if(!currentUser)return;
 const total=currentUser.earnedPoints;const thresholds=[0,100,300,600,1000,1500,2100,2800,3600,4500];let level=1;
 thresholds.forEach((p,i)=>{if(total>=p)level=i+1;});const next=thresholds[level]??Math.ceil(total/1000)*1000+1000,prev=thresholds[level-1];
 const progress=Math.min(100,Math.round(100*(total-prev)/(next-prev)));
 text('userLevelLabel','Уровень '+level);text('userProgressValue',progress+'%');text('profileNextLevel',Math.max(0,next-total)+' до следующего уровня');
 ['progressFill','profileProgressFill'].forEach(id=>$(id).style.width=progress+'%');
 text('profilePoints',total+' баллов за всё время');
 for(const [id,n]of Object.entries({userPoints:currentUser.points,profilePointsValue:currentUser.points,userTasksCompleted:currentUser.tasksCompleted,profileTasksCompleted:currentUser.tasksCompleted,userPhotoReports:currentUser.photoReports,profilePhotoReports:currentUser.photoReports,balanceAmount:currentUser.points}))text(id,n);
 const settings=currentUser.settings;
 document.querySelectorAll('[data-setting]').forEach(e=>e.textContent=settings[e.dataset.setting]?'Включено':'Выключено');
 document.documentElement.lang=settings.language;
 text('storedLanguage',settings.language==='ru'?'Русский':'English');
}
async function registerUser(){await action('register',async()=>{
 if(value('signupPassword')!==value('signupConfirmPassword'))throw Error('Пароли не совпадают.');
 const data=await api('/auth/register',{method:'POST',body:{firstName:value('signupFirstName'),lastName:value('signupLastName'),phone:value('signupPhone'),password:$('signupPassword').value}});
 currentUser=data.user;csrf=data.token;$('signupPassword').value='';$('signupConfirmPassword').value='';await showScreen('main-screen');notify('Аккаунт создан.');
});}
async function loginUser(){await action('login',async()=>{
 const data=await api('/auth/login',{method:'POST',body:{phone:value('loginPhone'),password:$('loginPassword').value}});currentUser=data.user;csrf=data.token;$('loginPassword').value='';await showScreen('main-screen');notify('Вход выполнен.');
});}
async function logout(){await action('logout',async()=>{await api('/auth/logout',{method:'POST'});currentUser=null;selectedTask=null;completionTask=null;userTasks=[];allTasks=[];csrf='';['userActivity','myReportsList','ownTasksList','activeTasksList','transactionsHistory','taskImage'].forEach(id=>$(id).replaceChildren());['photoPreview','taskCompletePhotoPreview'].forEach(id=>empty($(id),'Нажми, чтобы добавить фото'));$('create-task-screen').querySelector('.photo-preview').replaceChildren(node('span','','Нажми, чтобы добавить фото'));Object.keys(uploads).forEach(k=>delete uploads[k]);closeModal('logoutModal');updateUser();await showScreen('register-screen');});}
function showLogoutConfirmation(){$('logoutModal').style.display='flex';}
async function refresh(){currentUser=await api('/me');updateUser();await Promise.all([loadClaims(),loadActivities(),loadWithdrawals(),loadMyReports()]);}
function row(task){
 const e=node('div','task-item task-row');e.tabIndex=0;e.setAttribute('role','button');e.onclick=()=>openTaskDetails(task.id);e.onkeydown=ev=>{if(['Enter',' '].includes(ev.key)){ev.preventDefault();e.click();}};
 const symbols={trash:'▤',recycling:'↻',greening:'♧',other:'◇'};e.append(node('span','task-row-icon',symbols[task.category]));
 const content=node('div','task-content');content.append(node('div','task-title',task.title),node('div','task-subtitle',task.location));e.append(content);
 const difficulty=node('div','task-difficulty');difficulty.append(node('span','badge badge-'+task.difficulty,labels[task.difficulty]));e.append(difficulty,node('div','task-points',task.reward+' баллов'));return e;
}
async function loadTasks(){
 const request=++taskRequest;const list=$('tasksList');list.setAttribute('aria-busy','true');
 try{const data=await api('/tasks?'+new URLSearchParams({q:value('taskSearch'),category:taskCategory,page:tasksPage,limit:20}));if(request!==taskRequest)return;allTasks=data.items;taskTotal=data.total;text('tasksCount',data.total);list.replaceChildren();data.items.forEach(t=>list.append(row(t)));if(!data.items.length)empty(list,'Ничего не найдено. Измени запрос или категорию.');renderPager('taskPagination',tasksPage,data.total,20,p=>{tasksPage=p;loadTasks().catch(e=>notify(e.message,true));});}finally{if(request===taskRequest)list.removeAttribute('aria-busy');}
}
function renderPager(id,page,total,limit,callback){const e=$(id);e.replaceChildren();if(total<=limit)return;const prev=node('button','btn btn-outline','← Назад'),next=node('button','btn btn-outline','Далее →');prev.disabled=page===1;next.disabled=page*limit>=total;prev.onclick=()=>callback(page-1);next.onclick=()=>callback(page+1);e.append(prev,node('span','',page+' / '+Math.ceil(total/limit)),next);}
function filterTasks(category){taskCategory=category;tasksPage=1;activateTabs('tasks-screen',category,['all','trash','recycling','greening','other']);loadTasks().catch(e=>notify(e.message,true));}
function searchTasks(){clearTimeout(searchTimer);searchTimer=setTimeout(()=>{tasksPage=1;loadTasks().catch(e=>notify(e.message,true));},250);}
function activateTabs(screen,selected,keys){$(screen).querySelectorAll('.tab').forEach((e,i)=>e.classList.toggle('active',keys[i]===selected));}
async function browseTasks(){await showScreen('tasks-screen');}
async function openTaskDetails(id){await action('detail',async()=>{
 selectedTask=await api('/tasks/'+id);await showScreen('task-details-screen');
 text('taskTitle',selectedTask.title);text('taskDescription',selectedTask.description);text('taskLocation',selectedTask.location);text('taskReward',selectedTask.reward+' баллов');text('taskDeadline',new Date(selectedTask.deadline).toLocaleDateString('ru-RU'));
 const badge=$('task-details-screen').querySelector('.badge');badge.className='badge badge-'+selectedTask.difficulty;badge.textContent=labels[selectedTask.difficulty];
 imageInto($('taskImage'),selectedTask.photoId);
 const claim=userTasks.find(c=>c.taskId===id),button=$('taskActionBtn');button.textContent=claim?.status==='in_progress'?'Отправить фотоотчёт':!currentUser?'Войти, чтобы принять':labels[selectedTask.status]??'Принять задание';
 if(selectedTask.status==='ACTIVE'&&currentUser)button.textContent='Принять задание';
 button.onclick=()=>!currentUser?showScreen('login-screen'):claim?.status==='in_progress'?openTaskCompletion(id):selectedTask.status==='ACTIVE'?acceptTask():notify('Задание сейчас недоступно.');
 });}
function imageInto(container,id){container.replaceChildren();if(!id){container.append(node('span','','Фото не прикреплено'));return;}const image=node('img');image.src='/api/uploads/'+id;image.alt='Фото участка';image.style.cssText='width:100%;height:100%;object-fit:cover';container.append(image);}
async function acceptTask(){if(!selectedTask)return;await action('claim',async()=>{await api('/tasks/'+selectedTask.id+'/claim',{method:'POST'});await showScreen('active-tasks-screen');notify('Задание выбрано. Выполни уборку и отправь фотоотчёт.');});}
async function loadClaims(page=1){
 const data=await api('/me/claims?page='+page+'&limit=20');userTasks=data.items;const list=$('activeTasksList');list.replaceChildren();text('activeTasksCount',data.total);
 data.items.forEach(c=>{const item=row(c.task);item.onclick=()=>c.status==='in_progress'?openTaskCompletion(c.taskId):openTaskDetails(c.taskId);item.querySelector('.task-subtitle').textContent=labels[c.status]+(c.rejectionReason?' · '+c.rejectionReason:'');list.append(item);});if(!data.items.length)empty(list,'Выбери первое задание в разделе «Задания».');renderPager('claimsPagination',page,data.total,20,p=>loadClaims(p).catch(e=>notify(e.message,true)));
 const own=await api('/me/tasks?limit=20');const ownList=$('ownTasksList');ownList.replaceChildren();own.items.forEach(t=>{const item=row(t);item.querySelector('.task-subtitle').textContent=labels[t.status]+(t.rejectionReason?' · '+t.rejectionReason:'');ownList.append(item);});if(!own.items.length)empty(ownList,'Ты пока не предлагал задания.');
}
function openTaskCompletion(taskId){completionTask=taskId;delete uploads.complete;$('taskCompleteDescription').value='';empty($('taskCompletePhotoPreview'),'Нажми, чтобы добавить фото после уборки');showScreen('task-complete-screen');}
async function submitTaskCompletion(){await action('complete',async()=>{if(!completionTask||!uploads.complete)throw Error('Выбери задание и загрузи фото результата.');await api('/tasks/'+completionTask+'/complete',{method:'POST',body:{photoId:uploads.complete.id,description:value('taskCompleteDescription')}});await showScreen('active-tasks-screen');notify('Фотоотчёт отправлен модератору. Баллы начислятся после приёмки.');});}
function showPhotoOptions(context='report'){photoContext=context;$('photoModal').style.display='flex';}
function pickPhoto(camera){const targetContext=photoContext;closeModal('photoModal');const input=node('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';if(camera)input.setAttribute('capture','environment');input.onchange=()=>action('upload',async()=>{if(!input.files[0])return;const form=new FormData();form.append('file',input.files[0]);notify('Фото загружается…');const file=await api('/uploads',{method:'POST',body:form});uploads[targetContext]=file;imageInto(targetContext==='report'?$('photoPreview'):targetContext==='complete'?$('taskCompletePhotoPreview'):$('create-task-screen').querySelector('.photo-preview'),file.id);notify('Фото загружено.');});input.click();}
function takePhoto(){pickPhoto(true);}function choosePhoto(){pickPhoto(false);}
async function submitPhotoReport(){await action('report',async()=>{if(!uploads.report)throw Error('Загрузи фото мусора.');await api('/reports',{method:'POST',body:{photoId:uploads.report.id,description:value('photoDescription'),category:value('photoCategory'),address:value('photoAddress'),suggestedPoints:Number(value('photoPoints')),clientKey:key('report'),...(coordinates.report??{})}});delete draftKeys.report;delete uploads.report;['photoDescription','photoAddress'].forEach(id=>$(id).value='');empty($('photoPreview'),'Нажми, чтобы добавить новое фото');await refresh();notify('Сообщение отправлено на проверку. Оно не начисляет баллы автоматически.');});}
async function publishTask(){await action('create',async()=>{const description=value('taskProblemDescription');const geo=coordinates.task??{};await api('/tasks',{method:'POST',body:{title:description.slice(0,120),description,location:value('taskAddress'),reward:Number(value('taskPoints')),category:value('taskCategory'),difficulty:'easy',deadline:new Date(Date.now()+7*86400000).toISOString(),photoId:uploads.task?.id,clientKey:key('task'),...geo}});delete draftKeys.task;delete uploads.task;delete coordinates.task;['taskProblemDescription','taskAddress'].forEach(id=>$(id).value='');await showScreen('active-tasks-screen');notify('Задание предложено модератору. Появится в списке после публикации.');});}
function publishTaskForOthers(){showScreen('create-task-screen');$('taskProblemDescription').value=value('photoDescription');$('taskAddress').value=value('photoAddress');$('taskCategory').value=value('photoCategory');$('taskPoints').value=value('photoPoints');if(uploads.report){uploads.task=uploads.report;imageInto($('create-task-screen').querySelector('.photo-preview'),uploads.task.id);}closeModal('photoReportActionModal');}
function completeTaskYourself(){closeModal('photoReportActionModal');notify('Для подтверждённой уборки сначала выбери опубликованное задание.');showScreen('tasks-screen');}
async function loadActivities(page=1){const data=await api('/me/activities?page='+page+'&limit=20');const list=$('userActivity');list.replaceChildren();data.items.forEach(a=>{const e=node('div','task-item');e.append(node('div','task-title',a.description),node('div','task-subtitle',new Date(a.createdAt).toLocaleString('ru-RU')),node('div','task-points',(a.points>0?'+':'')+a.points));list.append(e);});if(!data.items.length)empty(list,'Первые действия появятся здесь.');renderPager('activityPagination',page,data.total,20,p=>loadActivities(p).catch(e=>notify(e.message,true)));}
async function loadMyReports(page=1){const data=await api('/me/reports?page='+page+'&limit=20');const list=$('myReportsList');list.replaceChildren();data.items.forEach(r=>{const e=node('div','task-item');e.append(node('div','task-title',r.address),node('div','task-subtitle',labels[r.status]+(r.rejectionReason?' · '+r.rejectionReason:'')));list.append(e);});if(!data.items.length)empty(list,'Здесь появятся твои сообщения о мусоре.');renderPager('reportsPagination',page,data.total,20,p=>loadMyReports(p).catch(e=>notify(e.message,true)));}
async function loadWithdrawals(page=1){const data=await api('/me/withdrawals?page='+page+'&limit=20');const list=$('transactionsHistory');list.replaceChildren();data.items.forEach(r=>{const e=node('div','task-item');e.append(node('div','task-title',r.amount+' баллов · '+labels[r.status]),node('div','task-subtitle',new Date(r.createdAt).toLocaleString('ru-RU')));if(r.status==='PENDING'){const b=node('button','btn btn-outline','Отменить заявку');b.onclick=()=>action('cancel',async()=>{await api('/withdrawals/'+r.id+'/cancel',{method:'POST'});await refresh();notify('Баллы возвращены.');});e.append(b);}list.append(e);});if(!data.items.length)empty(list,'Заявок на вывод пока нет.');renderPager('withdrawalsPagination',page,data.total,20,p=>loadWithdrawals(p).catch(e=>notify(e.message,true)));}
async function withdrawFunds(){await action('withdraw',async()=>{if(!currentUser)throw Error('Войди в аккаунт.');if(!confirm('Создать заявку на '+currentUser.points+' баллов? Баллы будут зарезервированы. Платёжный провайдер не подключён, реальная выплата не производится. Заявку можно отменить.'))return;await api('/withdrawals',{method:'POST',body:{amount:currentUser.points,clientKey:key('withdrawal')}});delete draftKeys.withdrawal;await refresh();notify('Заявка сохранена. Реальная выплата не выполнена.');});}
async function loadRating(page=1){const data=await api('/rating?'+new URLSearchParams({period:ratingPeriod,page,limit:20}));['all','month','year'].forEach(p=>$('rating-'+p).style.display=p===ratingPeriod?'block':'none');const list=$('rating-'+ratingPeriod);list.replaceChildren();data.items.forEach(u=>{const e=node('div','task-item');e.append(node('b','',u.rank+'.'),node('div','task-title',u.firstName+' '+u.lastName[0]+'.'),node('div','task-points',u.points+' баллов'));list.append(e);});if(!data.items.length)empty(list,'За этот период ещё нет принятых уборок.');const mine=data.items.find(u=>u.id===currentUser?.id);text('userRank',mine?mine.rank+' место':'Рейтинг обновляется после приёмки уборок');renderPager('ratingPagination',page,data.total,20,p=>loadRating(p).catch(e=>notify(e.message,true)));}
function changeRatingTab(period){ratingPeriod=period;activateTabs('rating-screen',period,['all','month','year']);loadRating().catch(e=>notify(e.message,true));}
function openNotificationSettings(type){notificationType=type;text('notificationSettingsTitle',{reminders:'Напоминания',verification:'Проверка отчётов',points:'Получение баллов'}[type]);$('notificationEnabled').checked=currentUser.settings[type];$('notificationSettingsModal').style.display='flex';}
async function saveNotificationSettings(){await action('settings',async()=>{currentUser=await api('/me/settings',{method:'PATCH',body:{...currentUser.settings,[notificationType]:$('notificationEnabled').checked}});updateUser();closeModal('notificationSettingsModal');notify('Настройка сохранена. История остаётся доступна в профиле.');});}
function openLanguageSettings(){$('languageModal').style.display='flex';}
async function selectLanguage(lang){await action('language',async()=>{currentUser=await api('/me/settings',{method:'PATCH',body:{...currentUser.settings,language:lang}});updateUser();translateUI(lang);closeModal('languageModal');notify(lang==='en'?'Language saved.':'Язык сохранён.');});}
const english={'Главная':'Home','Карта':'Map','Профиль':'Profile','Задания':'Tasks','Настройки':'Settings','Войти':'Sign in','Зарегистрироваться':'Sign up','Баланс':'Balance','Рейтинг':'Leaderboard','Телефон':'Phone','Пароль':'Password','Фамилия':'Last name','Имя':'First name','Подтвердите пароль':'Confirm password','Все':'All','Мусор':'Litter','Переработка':'Recycling','Озеленение':'Greening','Другое':'Other','Сообщить о мусоре':'Report litter','Описание проблемы':'Describe the issue','Категория':'Category','Адрес':'Address','Баллы за выполнение':'Suggested points','Отправить на проверку':'Submit for review','Поиск заданий':'Find tasks','Финансы':'Balance','Активные':'My tasks','Понятно':'OK','Назад':'Back','На главную':'Home','Мои задания':'My tasks'};
function translateUI(language){document.querySelectorAll('[data-ru]').forEach(e=>e.textContent=language==='en'?(english[e.dataset.ru]??e.dataset.ru):e.dataset.ru);}
function selectOnMap(){if(!window.L||!mapConfig.mapTileUrl){notify('Карта недоступна. Введи адрес вручную.',true);return;}const context=$('photo-report-screen').style.display==='block'?'report':'task';$('locationModal').style.display='flex';if(!pickerMap){pickerMap=L.map('locationPicker').setView([55.16,61.4],12);L.tileLayer(mapConfig.mapTileUrl,{attribution:mapConfig.mapAttribution.replace(/</g,'&lt;').replace(/>/g,'&gt;')}).addTo(pickerMap);}
 pickerMap.off('click');pickerMap.on('click',event=>{coordinates[context]={latitude:event.latlng.lat,longitude:event.latlng.lng};if(pickerMarker)pickerMarker.remove();pickerMarker=L.marker(event.latlng).addTo(pickerMap);text('pickedCoordinates',event.latlng.lat.toFixed(5)+', '+event.latlng.lng.toFixed(5));});setTimeout(()=>pickerMap.invalidateSize(),50);}
function saveLocation(){closeModal('locationModal');notify('Точка сохранена. Укажи адрес или ориентир в поле формы.');}
async function loadMap(){const data=await api('/tasks?category='+mapCategory+'&limit=50');const list=$('mapTasksList');list.replaceChildren();data.items.forEach(t=>list.append(row(t)));if(!data.items.length)empty(list,'В этой категории нет доступных заданий.');if(!window.L||!mapConfig.mapTileUrl){empty($('map'),'Карта не загрузилась. Задания доступны списком.');return;}if(!mapView){$('map').replaceChildren();mapView=L.map('map').setView([55.16,61.4],12);L.tileLayer(mapConfig.mapTileUrl,{attribution:mapConfig.mapAttribution.replace(/</g,'&lt;').replace(/>/g,'&gt;')}).addTo(mapView);taskLayer=L.layerGroup().addTo(mapView);}taskLayer.clearLayers();data.items.filter(t=>t.latitude!==null&&t.longitude!==null).forEach(t=>{const label=node('button','',t.title);label.onclick=()=>openTaskDetails(t.id);L.marker([t.latitude,t.longitude]).addTo(taskLayer).bindPopup(label);});text('mapSummary',data.total>50?'Показаны первые 50 заданий; полный список доступен в поиске.':'Задания без выбранной точки доступны в списке.');setTimeout(()=>mapView.invalidateSize(),50);}
function filterMapTasks(category){mapCategory=category;activateTabs('map-screen',category,['all','trash','recycling','greening']);loadMap().catch(e=>notify(e.message,true));}
function showOnMap(){if(selectedTask?.latitude!=null&&selectedTask?.longitude!=null){window.open('https://www.openstreetmap.org/?mlat='+selectedTask.latitude+'&mlon='+selectedTask.longitude+'#map=17/'+selectedTask.latitude+'/'+selectedTask.longitude,'_blank','noopener,noreferrer');}else notify('Точка не указана. Адрес: '+(selectedTask?.location??''));}
const openSettings=()=>showScreen('settings-screen'),openTasks=()=>showScreen('tasks-screen'),openBalance=()=>showScreen('balance-screen'),openRating=()=>showScreen('rating-screen'),openProfile=()=>showScreen('profile-screen'),openPhotoReport=()=>showScreen('photo-report-screen'),openActiveTasks=()=>showScreen('active-tasks-screen'),openCreateTask=()=>showScreen('create-task-screen'),openHelp=()=>showScreen('help-screen'),openAbout=()=>showScreen('about-screen');
document.addEventListener('DOMContentLoaded',async()=>{
 document.querySelectorAll('.form-group').forEach(group=>{const label=group.querySelector('label'),field=group.querySelector('input,textarea,select');if(label&&field?.id)label.htmlFor=field.id;});
 document.querySelectorAll('.tab,.activity-widget,.nav-item,.user-avatar,.settings-item[onclick],.photo-preview').forEach(e=>{e.tabIndex=0;e.setAttribute('role','button');e.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();e.click();}});});
 document.querySelectorAll('.form-label,.nav-text,.activity-widget-title,.tab').forEach(e=>e.dataset.ru=e.textContent.trim());
 document.querySelectorAll('.modal').forEach(e=>{e.setAttribute('role','dialog');e.setAttribute('aria-modal','true');e.addEventListener('click',ev=>{if(ev.target===e)e.style.display='none';});});
 document.addEventListener('keydown',ev=>{if(ev.key==='Escape')document.querySelectorAll('.modal').forEach(e=>e.style.display='none');});
 try{mapConfig=await api('/config');csrf=(await api('/auth/csrf')).token;currentUser=await api('/me');updateUser();translateUI(currentUser.settings.language);await showScreen('main-screen');await checkNotifications();}catch(e){await showScreen('register-screen');if(!e.message.includes('Войди'))notify(e.message,true);}
});

async function checkNotifications(){
 if(!currentUser)return;
 try{const data=await api('/me/notifications');if(data.items.length){notify(data.items.map(item=>item.description).join('\n'));await api('/me/notifications/read',{method:'POST'});}}catch(e){console.warn('Notifications unavailable');}
}
setInterval(checkNotifications,30000);
