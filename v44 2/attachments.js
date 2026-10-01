/* Native Grist documents, compatible with historical File_Data records. */
'use strict';
var documentStorage={busy:false,cancel:false,metadataMode:'unknown',sqlUnavailable:false,token:null,previewRequest:0,backupUrls:[],backupParts:[],backupSnapshot:null};
var DOCUMENT_MAX_BYTES=20*1024*1024, BACKUP_MAX_BYTES=64*1024*1024;
function documentColumns(){return [{id:'Attachment',type:'Attachments'},{id:'SHA256',type:'Text'},{id:'Verified_At',type:'DateTime'}]}
async function ensureDocumentColumns(){
  var tables=await grist.docApi.fetchTable('_grist_Tables'),columns=await grist.docApi.fetchTable('_grist_Tables_column');
  var index=tables.tableId.indexOf(TABLES.files),ref=tables.id[index];
  if(!ref)throw new Error('Table des documents introuvable.');
  var actions=[];
  documentColumns().forEach(function(c){var i=columns.id.findIndex(function(id,j){return columns.parentId[j]===ref&&columns.colId[j]===c.id});if(i<0)actions.push(['AddColumn',TABLES.files,c.id,{type:c.type}]);else if(String(columns.type[i]).split(':')[0]!==c.type)throw new Error('Type incompatible pour la colonne documents '+c.id);});
  if(actions.length)await grist.docApi.applyUserActions(actions);
}
function attachmentId(file){var a=file.Attachment;if(a==null||a===0||a==='')return null;if(!Array.isArray(a)||a[0]!=='L'||a.length!==2||!Number.isSafeInteger(a[1])||a[1]<=0)throw new Error('La ligne doit contenir exactement une pièce jointe.');return a[1]}
function hasNativeDocument(file){return !!file.Has_Attachment||!!(Array.isArray(file.Attachment)&&file.Attachment.length>1)}
function hasLegacyDocument(file){return !!file.Has_Legacy||!!file.File_Data}
function documentError(response){var code=response.status;return new Error(code===413?'Le fichier dépasse la limite autorisée par votre serveur Grist.':code===401||code===403?'Accès aux documents refusé. Vérifiez les droits du widget et votre connexion Grist.':code===429?'Grist reçoit trop de demandes. Réessayez dans un instant.':'Grist n’a pas pu traiter le document (HTTP '+code+').')}
async function documentRequest(path,options){
  options=options||{};
  for(var attempt=0;attempt<2;attempt++){
    var access=documentStorage.token;
    if(!access||access.expires<Date.now()){
      var token=await grist.docApi.getAccessToken({readOnly:!options.write});
      var base=new URL(token.baseUrl);
      if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname)))throw new Error('Adresse Grist non sécurisée.');
      access={baseUrl:token.baseUrl.replace(/\/$/,''),token:token.token,write:!!options.write,expires:Date.now()+Math.max(0,Number(token.ttlMsecs)-10000)};
      documentStorage.token=access;
    }
    if(options.write&&!access.write){documentStorage.token=null;attempt--;continue}
    var url=new URL(access.baseUrl+path);url.searchParams.set('auth',access.token);
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},120000);
    try{
      var response=await fetch(url.href,{method:options.method||'GET',body:options.body,headers:options.headers,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});
      // Only an explicit rejection is retried. A lost upload response is never replayed automatically.
      if((response.status===401||response.status===403)&&attempt===0){documentStorage.token=null;continue}
      if(!response.ok)throw documentError(response);
      return options.blob?await response.blob():await response.json();
    }catch(e){if(e.name==='AbortError')throw new Error('Délai dépassé. Vérifiez la connexion avant de réessayer.');if(e.name==='TypeError')throw new Error('Connexion aux pièces jointes impossible. Le serveur peut bloquer cet accès depuis le widget.');throw e}finally{clearTimeout(timer)}
  }
}
async function fetchDocumentMetadata(){
  if(!documentStorage.sqlUnavailable){
    try{
      // Never select File_Data here. Attachments are marshalled blobs in SQLite;
      // their IDs are read through the typed records API only when a file is opened.
      var sql='SELECT id, Parent_Type, Parent_Id, File_Name, File_Type, File_Size, Created_At, SHA256, Verified_At, CASE WHEN length(File_Data)>0 THEN 1 ELSE 0 END AS Has_Legacy, CASE WHEN typeof(Attachment)=\'blob\' THEN 1 ELSE 0 END AS Has_Attachment FROM PM_SoloDocuments ORDER BY id';
      var data=await documentRequest('/sql?q='+encodeURIComponent(sql));
      if(!data||!Array.isArray(data.records))throw new Error('Réponse de Grist invalide.');
      documentStorage.metadataMode='light';return data.records.map(function(r){return r.fields});
    }catch(e){documentStorage.sqlUnavailable=true}
  }
  // Compatibility with instances which do not expose SQL to widgets.
  var table=await grist.docApi.fetchTable(TABLES.files);documentStorage.metadataMode='compatible';
  return records(table,fileMap());
}
async function fetchDocumentRecord(id){
  id=Number(id);if(!Number.isSafeInteger(id)||id<=0)throw new Error('Document invalide.');
  var data=await documentRequest('/tables/'+encodeURIComponent(TABLES.files)+'/records?filter='+encodeURIComponent(JSON.stringify({id:[id]})));
  var row=data.records&&data.records.find(function(r){return Number(r.id)===id});
  if(!row)throw new Error('Ce document n’est plus disponible.');return Object.assign({id:row.id},row.fields);
}
function legacyDocumentBlob(file){
  var value=String(file.File_Data||''),comma=value.indexOf(',');
  if(!value.startsWith('data:')||comma<0)throw new Error('Ancien document absent ou illisible.');
  var meta=value.slice(0,comma),raw=value.slice(comma+1),bytes;
  if(/;base64$/i.test(meta)){var binary=atob(raw);bytes=new Uint8Array(binary.length);for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)}
  else bytes=new TextEncoder().encode(decodeURIComponent(raw));
  return new Blob([bytes],{type:file.File_Type||'application/octet-stream'});
}
async function documentHash(blob){if(!crypto.subtle)throw new Error('La vérification des fichiers nécessite une connexion HTTPS.');var bytes=await blob.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(function(b){return b.toString(16).padStart(2,'0')}).join('')}
async function verifiedNativeBlob(file,expectedHash,expectedSize){
  var id=attachmentId(file);if(!id)throw new Error('Pièce jointe native absente.');
  var blob=await documentRequest('/attachments/'+id+'/download',{blob:true});
  if(expectedSize!=null&&blob.size!==Number(expectedSize))throw new Error('Taille du document différente : opération interrompue.');
  var hash=await documentHash(blob);if(expectedHash&&hash!==expectedHash)throw new Error('Contenu du document différent : opération interrompue.');
  return {blob:blob,hash:hash};
}
async function loadDocumentBlob(file){
  if(file.File_Data&&!hasNativeDocument(file))return legacyDocumentBlob(file);
  var full;
  try{full=state.demo?file:await fetchDocumentRecord(file.id)}catch(e){if(!file.File_Data)throw e;toast('Lecture de la copie historique : connexion native indisponible.');return legacyDocumentBlob(file)}
  if(attachmentId(full)){
    try{return (await verifiedNativeBlob(full,full.SHA256||null,full.File_Size)).blob}
    catch(e){if(!full.File_Data)throw e;toast('Lecture de la copie historique : la pièce native est indisponible.');return legacyDocumentBlob(full)}
  }
  return legacyDocumentBlob(full);
}
function safeDocumentName(name){return String(name||'document').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g,'_').replace(/^\.+/,'_').slice(0,140)||'document'}
function saveDocumentBlob(blob,name){var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=safeDocumentName(name);a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},60000)}
async function downloadNativeDocument(id){var file=state.files.find(function(f){return String(f.id)===String(id)});if(!file)return;try{toast('Préparation du téléchargement…');saveDocumentBlob(await loadDocumentBlob(file),file.File_Name)}catch(e){toast(e.message)}}
function safePreviewType(file){
  var type=String(file.File_Type||'').toLowerCase().split(';')[0],name=String(file.File_Name||'').toLowerCase();
  if(type==='application/pdf'||/\.pdf$/.test(name))return 'application/pdf';
  if(/^image\/(png|jpeg|gif|webp|bmp)$/.test(type))return type;
  if(/^text\//.test(type)||/\.(txt|csv|md|json)$/.test(name))return 'text/plain';
  return '';
}
async function prepareDocumentPreviewFrame(blob,type){
  var frame=$('file-preview-frame');
  // Native PDF viewers cannot run inside a sandboxed iframe. Only relax this
  // frame for PDF bytes, which are subsequently served with application/pdf.
  // HTML and other text keep both the sandbox and a forced text/plain MIME.
  frame.setAttribute('sandbox','allow-same-origin allow-downloads');
  if(type==='application/pdf'){
    var header=await blob.slice(0,1024).text();
    if(!header.includes('%PDF-'))throw new Error('Ce fichier ne semble pas être un PDF valide. Vous pouvez toujours le télécharger.');
    return true;
  }
  return false;
}
async function viewNativeDocument(id){
  var file=state.files.find(function(f){return String(f.id)===String(id)});if(!file)return;
  var request=++documentStorage.previewRequest;if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=''}
  $('file-preview-title').textContent=file.File_Name||'Document';$('file-preview-info').textContent=formatFileSize(file.File_Size)+' · Chargement…';
  $('file-preview-frame').setAttribute('sandbox','allow-same-origin allow-downloads');$('file-preview-frame').src='about:blank';$('file-preview-frame').classList.add('hidden');$('file-preview-unavailable').classList.remove('hidden');$('file-preview-message').textContent='Chargement du document…';$('file-preview-open').classList.add('hidden');$('file-preview-download').disabled=true;showModal('file-preview-modal');
  try{
    var blob=await loadDocumentBlob(file);if(request!==documentStorage.previewRequest)return;
    var type=safePreviewType(file);$('file-preview-info').textContent=formatFileSize(blob.size)+(file.File_Type?' · '+file.File_Type:'');
    $('file-preview-download').disabled=false;$('file-preview-download').onclick=function(){saveDocumentBlob(blob,file.File_Name)};
    if(type){var nativePdf=await prepareDocumentPreviewFrame(blob,type);if(request!==documentStorage.previewRequest)return;if(nativePdf)$('file-preview-frame').removeAttribute('sandbox');previewUrl=URL.createObjectURL(new Blob([blob],{type:type}));$('file-preview-frame').src=previewUrl;$('file-preview-frame').classList.remove('hidden');$('file-preview-unavailable').classList.add('hidden');$('file-preview-open').classList.remove('hidden');$('file-preview-open').onclick=function(){window.open(previewUrl,'_blank','noopener')}}
    else $('file-preview-message').textContent='Téléchargez ce document pour l’ouvrir dans son application habituelle.';
  }catch(e){if(request===documentStorage.previewRequest){$('file-preview-info').textContent='Chargement impossible';$('file-preview-message').textContent=e.message}}
}
async function uploadNativeBlob(blob,name){
  var form=new FormData();form.append('upload',blob,name);
  var ids=await documentRequest('/attachments',{method:'POST',body:form,write:true,headers:{'X-Requested-With':'XMLHttpRequest'}});
  if(!Array.isArray(ids)||ids.length!==1||!Number.isSafeInteger(ids[0])||ids[0]<=0)throw new Error('Grist n’a pas confirmé l’envoi. Aucun nouvel essai automatique.');return ids[0];
}
async function withDocumentLock(work){
  if(documentStorage.busy){toast('Une opération sur les documents est déjà en cours.');return}
  documentStorage.busy=true;documentStorage.cancel=false;
  try{
    var docName=state.demo?'demo':await grist.docApi.getDocName();
    if(navigator.locks)return await navigator.locks.request('jira-pas-documents-'+docName,{ifAvailable:true},async function(lock){if(!lock)throw new Error('Une opération sur les documents est déjà ouverte dans un autre onglet.');return work()});
    return await work();
  }finally{documentStorage.busy=false;renderDocumentStorage()}
}
async function reusableAttachment(hash,size){
  var known=state.files.find(function(f){return f.SHA256===hash&&hasNativeDocument(f)});if(!known)return null;
  var full=await fetchDocumentRecord(known.id);await verifiedNativeBlob(full,hash,size);return attachmentId(full);
}
async function existingDocumentForUpload(type,parentId,file,hash){
  var name=String(file.name).normalize('NFC');
  var candidates=state.files.filter(function(f){return f.Parent_Type===type&&Number(f.Parent_Id)===parentId&&String(f.File_Name||'').normalize('NFC')===name});
  for(var i=0;i<candidates.length;i++){
    var candidate=candidates[i];
    // A duplicate is a comparison, not a new verification/download operation.
    // This also works when the native REST API is temporarily unavailable.
    if(hasNativeDocument(candidate)&&candidate.SHA256===hash)return candidate;
    var full=candidate;
    if(!full.File_Data&&hasLegacyDocument(full))full=await fetchDocumentRecord(full.id);
    if(full.File_Data){var blob=legacyDocumentBlob(full);if(blob.size===file.size&&await documentHash(blob)===hash)return candidate}
  }
  return null;
}
async function uploadNativeFiles(type,fileList){
  var id=relatedId(type),files=Array.from(fileList||[]),status=$(type+'-file-status'),compatible=$(type+'-file-mode')&&$(type+'-file-mode').value==='compatible';if(!id||!files.length)return;
  if(state.demo){toast('L’ajout de pièces jointes est disponible dans Grist.');return}
  try{await withDocumentLock(async function(){
    var added=0,duplicates=0,errors=[],writeAttempted=false;
    for(var i=0;i<files.length;i++){
      var file=files[i];status.textContent='Ajout '+(i+1)+' / '+files.length+' : '+file.name;
      try{
        if(file.size>(compatible?5*1024*1024:DOCUMENT_MAX_BYTES))throw new Error(compatible?'Mode compatible : 5 Mo maximum par fichier.':'Limite du widget : 20 Mo par fichier.');
        var hash=await documentHash(file);
        var duplicate=await existingDocumentForUpload(type,id,file,hash);
        if(duplicate){duplicates++;continue}
        if(compatible){
          // Explicit choice before sending; never retry an uncertain native upload
          // by silently creating another copy in the historical storage.
          var legacyData=await readFile(file);
          var legacyFields={Parent_Type:type,Parent_Id:id,File_Name:file.name,File_Type:file.type||'',File_Size:file.size,File_Data:legacyData,SHA256:hash,Created_At:now()};
          writeAttempted=true;var legacyId=await addRecord(TABLES.files,legacyFields);legacyFields.id=legacyId;state.files.push(legacyFields);added++;continue;
        }
        var nativeId=await reusableAttachment(hash,file.size)||await uploadNativeBlob(file,file.name);
        var fields={Parent_Type:type,Parent_Id:id,File_Name:file.name,File_Type:file.type||'',File_Size:file.size,File_Data:'',Attachment:['L',nativeId],SHA256:hash,Verified_At:null,Created_At:now()};
        // Attach first, then verify. If verification fails, the attached file stays
        // visible and can be verified again; it is never deleted automatically.
        writeAttempted=true;var rowId=await addRecord(TABLES.files,fields);fields.id=rowId;state.files.push(fields);
        await verifiedNativeBlob(fields,hash,file.size);await updateRecord(TABLES.files,rowId,{Verified_At:now()});added++;
      }catch(e){errors.push(file.name+' : '+e.message+(!compatible?' Si l’accès reste bloqué, choisissez « Compatible » avant de sélectionner à nouveau le fichier.':''))}
    }
    // Do not reload all tables (and legacy file contents in compatibility mode)
    // when nothing was written, including a duplicate or a failed upload.
    if(writeAttempted)await loadData();if(relatedId(type)===id)renderRelated(type,id);
    status.textContent=added+' ajouté(s), '+duplicates+' déjà présent(s).'+(errors.length?' '+errors.join(' · '):'');
  })}catch(e){status.textContent=e.message}
}

function storageMessage(message){if($('document-storage-status'))$('document-storage-status').textContent=message}
function storageCounts(){var rows=state.files;return {total:rows.length,bytes:rows.reduce(function(n,f){return n+(Number(f.File_Size)||0)},0),legacy:rows.filter(hasLegacyDocument).length,native:rows.filter(hasNativeDocument).length,unverified:rows.filter(function(f){return hasNativeDocument(f)&&!f.Verified_At}).length}}
function renderDocumentStorage(){
  if(!$('document-storage-summary'))return;
  var counts=storageCounts();
  $('document-storage-summary').textContent=counts.total+' document(s) · '+formatFileSize(counts.bytes)+' de fichiers · '+counts.native+' au format natif · '+counts.legacy+' avec une ancienne copie · '+counts.unverified+' à vérifier';
  $('document-storage-mode').textContent=documentStorage.metadataMode==='light'?'Chargement léger : seuls les noms et les informations des documents sont chargés.':documentStorage.metadataMode==='compatible'?'Mode compatible : cette instance charge encore les anciennes copies avec les données. Leur nettoyage après vérification réduira ce volume.':'Les documents seront accessibles après connexion à Grist.';
  ['document-migrate','document-verify','document-clean','document-check'].forEach(function(id){$(id).disabled=documentStorage.busy||state.demo});
  $('document-stop').disabled=!documentStorage.busy;
  $('document-clean').disabled=documentStorage.busy||state.demo||!$('document-backup-confirm').checked;
  $('document-backup-parts').querySelectorAll('button').forEach(function(b){b.disabled=documentStorage.busy});
}
function openDocumentStorage(){
  renderDocumentStorage();renderDocumentBackupParts();showModal('document-storage-modal');
}
async function checkDocumentStorage(){
  if(state.demo){toast('Disponible dans Grist.');return}
  try{await withDocumentLock(async function(){
    renderDocumentStorage();await documentRequest('/attachments?limit=1');
    var location='';try{var store=await documentRequest('/attachments/store');location=store.type==='internal'?' Stockage interne au document Grist.':store.type==='external'?' Stockage géré par l’instance Grist, à sauvegarder aussi via l’export de ses pièces jointes.':''}catch(e){}
    documentStorage.sqlUnavailable=false;state.files=await fetchDocumentMetadata();
    storageMessage('Connexion aux pièces jointes disponible.'+location+' Pour valider l’envoi sur cette instance, ajoutez un petit document à une tâche de test.');renderDocumentBackupParts();
  })}catch(e){storageMessage(e.message)}
}
async function migrateDocumentRecord(id){
  var file=await fetchDocumentRecord(id),legacy=file.File_Data?legacyDocumentBlob(file):null;
  if(!legacy){if(attachmentId(file)){var checked=await verifiedNativeBlob(file,file.SHA256||null,file.File_Size);await updateRecord(TABLES.files,file.id,{SHA256:checked.hash,Verified_At:now()});return}throw new Error('Aucun contenu disponible.');}
  var hash=await documentHash(legacy),native=attachmentId(file);
  if(!native){
    native=await reusableAttachment(hash,legacy.size)||await uploadNativeBlob(legacy,file.File_Name||'document');
    var current=await fetchDocumentRecord(id);
    if(current.File_Data!==file.File_Data)throw new Error('Document modifié pendant la conversion. Ancienne copie conservée.');
    if(attachmentId(current))native=attachmentId(current);
    else await updateRecord(TABLES.files,id,{Attachment:['L',native],SHA256:hash,Verified_At:null});
  }
  // Read the actual attached record and file again, rather than trusting the upload response.
  var attached=await fetchDocumentRecord(id),result=await verifiedNativeBlob(attached,hash,legacy.size);
  if(attached.File_Data!==file.File_Data)throw new Error('Document modifié pendant la vérification. Ancienne copie conservée.');
  await updateRecord(TABLES.files,id,{SHA256:result.hash,File_Size:legacy.size,Verified_At:now()});
}
async function cleanDocumentRecord(id){
  var file=await fetchDocumentRecord(id);if(!file.File_Data)return;
  var blob=legacyDocumentBlob(file),hash=await documentHash(blob);
  if(!documentStorage.backupSnapshot||documentStorage.backupSnapshot.get(String(id))!==hash)throw new Error('Une sauvegarde téléchargée de cette version du fichier est nécessaire.');
  var native=attachmentId(file);await verifiedNativeBlob(file,hash,blob.size);
  // Check immediately before writing; serialize cooperating tabs with Web Locks.
  var current=await fetchDocumentRecord(id);
  if(current.File_Data!==file.File_Data||attachmentId(current)!==native)throw new Error('Le document a changé : ancienne copie conservée.');
  await updateRecord(TABLES.files,id,{File_Data:'',SHA256:hash,File_Size:blob.size,Verified_At:now()});
}
async function runDocumentMaintenance(action){
  if(state.demo){toast('Disponible dans Grist.');return}
  if(action==='clean'&&!$('document-backup-confirm').checked){storageMessage('Enregistrez et contrôlez la sauvegarde sur votre Mac avant le nettoyage.');return}
  if(action==='clean'&&!confirm('Alléger les anciennes copies sauvegardées ? Chaque pièce native sera relue et comparée avant de retirer son ancien contenu texte. Après cela, utilisez la v44 pour ouvrir ces documents.'))return;
  try{await withDocumentLock(async function(){
    renderDocumentStorage();state.files=await fetchDocumentMetadata();
    var list=state.files.filter(function(f){return action==='migrate'?hasLegacyDocument(f)&&(!hasNativeDocument(f)||!f.Verified_At):action==='verify'?hasNativeDocument(f)&&!f.Verified_At:hasLegacyDocument(f)&&hasNativeDocument(f)&&documentStorage.backupSnapshot&&documentStorage.backupSnapshot.has(String(f.id))}).slice(0,20);
    var successes=0,errors=[];
    for(var i=0;i<list.length&&!documentStorage.cancel;i++){
      storageMessage((action==='clean'?'Nettoyage':'Conversion / vérification')+' '+(i+1)+' / '+list.length+' : '+list[i].File_Name);
      try{if(action==='clean')await cleanDocumentRecord(list[i].id);else await migrateDocumentRecord(list[i].id);successes++}catch(e){errors.push(list[i].File_Name+' : '+e.message)}
    }
    await loadData();renderDocumentBackupParts();
    storageMessage(successes+' document(s) traité(s).'+(documentStorage.cancel?' Opération arrêtée entre deux fichiers.':'')+(errors.length?' Échec(s), anciennes copies conservées : '+errors.join(' · '):'')+(!list.length?' Aucun document éligible pour cette opération.':list.length===20?' Relancez pour poursuivre les suivants.':''));
  })}catch(e){storageMessage(e.message)}
}
function documentBackupParts(){
  var parts=[],current=[],size=0;
  state.files.slice().sort(function(a,b){return Number(a.id)-Number(b.id)}).forEach(function(f){var bytes=Number(f.File_Size)||0;if(current.length&&(size+bytes>BACKUP_MAX_BYTES||current.length>=200)){parts.push(current);current=[];size=0}current.push(Object.assign({},f));size+=bytes});
  if(current.length)parts.push(current);return parts;
}
function renderDocumentBackupParts(){
  documentStorage.backupParts=documentBackupParts();
  $('document-backup-parts').innerHTML=documentStorage.backupParts.length?documentStorage.backupParts.map(function(part,i){return '<button type="button" class="btn small" onclick="prepareDocumentBackup('+i+')" '+(documentStorage.busy?'disabled':'')+'>Préparer l’archive '+(i+1)+' / '+documentStorage.backupParts.length+' · '+part.length+' fichier(s) · '+formatFileSize(part.reduce(function(s,f){return s+(Number(f.File_Size)||0)},0))+'</button>'}).join(''):'<p class="sub">Aucun document à sauvegarder.</p>';
}
function documentBackupPath(file){
  var tasks=state.tasks.concat(state.archivedTasks,state.projectArchivedTasks),projects=state.projects.concat(state.archivedProjects),task=file.Parent_Type==='task'&&tasks.find(function(t){return String(t.id)===String(file.Parent_Id)}),projectId=file.Parent_Type==='project'?file.Parent_Id:task&&task.Project_Id,project=projects.find(function(p){return String(p.id)===String(projectId)});
  var folder=project?'projet-'+project.id+'-'+safeDocumentName(project.Name):'sans-projet';
  if(file.Parent_Type==='task')folder+='/tache-'+file.Parent_Id+'-'+safeDocumentName(task?task.Title:'indisponible');else folder+='/documents-projet';
  return folder+'/'+file.id+'-'+safeDocumentName(file.File_Name);
}
async function prepareDocumentBackup(index){
  var part=documentStorage.backupParts[index];if(!part)return;
  try{await withDocumentLock(async function(){
    renderDocumentStorage();var zip=new JSZip(),manifest=[],total=0;
    for(var i=0;i<part.length;i++){
      if(documentStorage.cancel)throw new Error('Préparation arrêtée. Aucune archive partielle n’a été proposée.');
      var file=part[i];storageMessage('Sauvegarde '+(i+1)+' / '+part.length+' : '+file.File_Name);
      if(Number(file.File_Size)>BACKUP_MAX_BYTES)throw new Error('Ce fichier dépasse 64 Mo. Téléchargez-le individuellement : '+file.File_Name);
      var blob=await loadDocumentBlob(file);total+=blob.size;if(total>BACKUP_MAX_BYTES)throw new Error('Le volume réel dépasse 64 Mo. Actualisez la liste des documents avant de reprendre.');
      var hash=await documentHash(blob),path=documentBackupPath(file);
      zip.file(path,await blob.arrayBuffer(),{binary:true});
      manifest.push({id:file.id,name:file.File_Name,parentType:file.Parent_Type,parentId:file.Parent_Id,size:blob.size,sha256:hash,path:path});
    }
    zip.file('inventaire.json',JSON.stringify({createdAt:new Date().toISOString(),part:index+1,parts:documentStorage.backupParts.length,documents:manifest},null,2));
    zip.file('LIRE-MOI.txt','Sauvegarde des fichiers JIRA pas. Chaque fichier est conservé dans son format original. Les liens avec les tâches et projets et les empreintes SHA-256 figurent dans inventaire.json. Cette archive ne remplace pas la sauvegarde complète du document Grist.');
    storageMessage('Assemblage de l’archive…');var result=await zip.generateAsync({type:'blob',compression:'STORE'});
    documentStorage.backupUrls.forEach(function(url){URL.revokeObjectURL(url)});documentStorage.backupUrls=[];
    var url=URL.createObjectURL(result);documentStorage.backupUrls.push(url);
    var link=$('document-backup-download');link.href=url;link.download='JIRA-pas-documents-'+localDateKey(new Date())+'-partie-'+(index+1)+'.zip';link.textContent='Télécharger l’archive '+(index+1)+' ('+formatFileSize(result.size)+')';link.classList.remove('hidden');
    link.onclick=function(){if(!documentStorage.backupSnapshot)documentStorage.backupSnapshot=new Map();manifest.forEach(function(f){documentStorage.backupSnapshot.set(String(f.id),f.sha256)});storageMessage('Archive transmise au navigateur. Enregistrez-la dans votre dossier Mac et vérifiez son ouverture.');};
    storageMessage('Archive '+(index+1)+' prête. Cliquez sur Télécharger, puis préparez la suivante s’il y en a plusieurs.');
  })}catch(e){storageMessage(e.message)}
}
