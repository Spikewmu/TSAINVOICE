/**
 * TSA Sales Tracking + Invoicing - shared backend (data + user accounts).
 *
 * One Google Sheet becomes the shared database for the dashboard: every rep's
 * submissions and every user login live here, so it works across all devices.
 *
 * SETUP (about 5 minutes):
 * 1. Create a new Google Sheet. Copy its ID from the URL:
 *    docs.google.com/spreadsheets/d/<THIS_PART>/edit
 * 2. In that Sheet: Extensions > Apps Script. Delete the sample, paste this file.
 * 3. Set SHEET_ID and ADMIN_PASS below (ADMIN_PASS must match the app's master
 *    admin password in Settings, default "tsaboss" - change both to something strong).
 * 4. Deploy > New deployment > type "Web app".
 *      Execute as: Me.   Who has access: Anyone.
 *    Deploy, authorize, copy the Web App URL (ends in /exec).
 * 5. In the dashboard: sign in as tsaboss, Settings > paste the URL, Save.
 *    Then use the Users tab to create rep logins.
 *
 * Two tabs auto-create: "records" (submissions) and "users" (accounts).
 * Passwords are stored only as salted SHA-256 hashes, never in plain text.
 */

var SHEET_ID  = 'PASTE_YOUR_SHEET_ID_HERE';
var ADMIN_PASS = 'tsaboss';                 // must match the app's master admin password
var MANAGER_PASS = 'TSAmgr2026';            // must match the app's managerCode; lets Sales Managers create closers/setters
var SALT = 'tsa-sales-salt-change-me';      // change once, before creating users

var REC_TAB = 'records';
var USR_TAB = 'users';
var REC_COLS = [
  'id','type','role','date','client','rep','setter','product','callType',
  'followUpOutreach','newOutreach','callsOffered','callsSet','callCapacity','speedToLead',
  'newMeetings','connectedMeetings','followUpMeetings','advancedCalls','noShows',
  'closedDeals','contractsSigned','contractValue','cashCollected','depositCollected',
  'aosiSold','productBSold','notes','submittedAt'
];

function ss_(){ return SpreadsheetApp.openById(SHEET_ID); }
function tab_(name, header){
  var ss = ss_(); var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(header); }
  return sh;
}
function hash_(pw){
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SALT + '|' + pw);
  return raw.map(function(b){ b = (b<0)?b+256:b; var s=b.toString(16); return s.length==1?'0'+s:s; }).join('');
}
function json_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function rowsAsObjects_(sh){
  var v = sh.getDataRange().getValues(); var out=[]; if(v.length<2) return out;
  var head=v[0];
  for(var r=1;r<v.length;r++){ var o={}; for(var c=0;c<head.length;c++) o[head[c]]=v[r][c]; out.push(o); }
  return out;
}

/* ---------- GET: return all records ---------- */
function doGet(){ return json_(rowsAsObjects_(tab_(REC_TAB, REC_COLS))); }

/* ---------- POST: records + auth actions ---------- */
function doPost(e){
  var body = JSON.parse(e.postData.contents);
  var action = body.action;

  if(action === 'login')      return login_(body);
  if(action === 'listUsers')  return requireManager_(body, listUsers_);
  if(action === 'saveUser')   return requireManager_(body, saveUser_);
  if(action === 'deleteUser') return requireAdmin_(body, deleteUser_);

  // no action -> it is a data record
  return appendRecord_(body);
}

function requireAdmin_(body, fn){
  if(body.adminPass !== ADMIN_PASS) return json_({ ok:false, error:'not authorized' });
  return fn(body);
}
// admin OR manager (managers can list + create closers/setters, not delete)
function requireManager_(body, fn){
  if(body.adminPass !== ADMIN_PASS && body.adminPass !== MANAGER_PASS) return json_({ ok:false, error:'not authorized' });
  return fn(body);
}

/* ---------- records ---------- */
function appendRecord_(rec){
  var sh = tab_(REC_TAB, REC_COLS);
  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  Object.keys(rec).forEach(function(k){ if(head.indexOf(k)===-1){ sh.getRange(1,head.length+1).setValue(k); head.push(k); } });
  sh.appendRow(head.map(function(k){ return rec[k]!=null?rec[k]:''; }));
  return json_({ ok:true, id:rec.id });
}

/* ---------- users ---------- */
function usersSheet_(){ return tab_(USR_TAB, ['username','name','role','passHash']); }

function login_(body){
  var u = String(body.username||'').trim().toLowerCase();
  var rows = rowsAsObjects_(usersSheet_());
  for(var i=0;i<rows.length;i++){
    if(String(rows[i].username).toLowerCase() === u){
      if(rows[i].passHash === hash_(body.password)) return json_({ ok:true, name:rows[i].name, role:rows[i].role });
      return json_({ ok:false });
    }
  }
  return json_({ ok:false });
}
function listUsers_(){
  var rows = rowsAsObjects_(usersSheet_());
  return json_({ ok:true, users: rows.map(function(r){ return { username:r.username, name:r.name, role:r.role }; }) });
}
function saveUser_(body){
  var u = body.user; if(!u || !u.username) return json_({ ok:false, error:'missing user' });
  // managers (MANAGER_PASS) can only create closers/setters, never admins/managers
  if(body.adminPass !== ADMIN_PASS && u.role !== 'closer' && u.role !== 'setter') u.role = 'closer';
  var uname = String(u.username).trim().toLowerCase();
  var sh = usersSheet_();
  var data = sh.getDataRange().getValues(); // [head, ...]
  for(var r=1;r<data.length;r++){
    if(String(data[r][0]).toLowerCase() === uname){
      sh.getRange(r+1,1,1,4).setValues([[uname, u.name, u.role, hash_(u.password)]]);
      return json_({ ok:true, updated:true });
    }
  }
  sh.appendRow([uname, u.name, u.role, hash_(u.password)]);
  return json_({ ok:true, created:true });
}
function deleteUser_(body){
  var uname = String(body.username||'').trim().toLowerCase();
  var sh = usersSheet_();
  var data = sh.getDataRange().getValues();
  for(var r=data.length-1;r>=1;r--){ if(String(data[r][0]).toLowerCase()===uname) sh.deleteRow(r+1); }
  return json_({ ok:true });
}
