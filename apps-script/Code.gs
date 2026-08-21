/**
 * TSA Sales Tracking + Invoicing - shared data backend.
 *
 * This turns a single Google Sheet into the shared database for the dashboard,
 * so every rep submits into one place and leadership sees the aggregate.
 *
 * SETUP (5 minutes):
 * 1. Create a new Google Sheet. Copy its ID from the URL
 *    (docs.google.com/spreadsheets/d/<THIS_PART>/edit).
 * 2. In that Sheet: Extensions > Apps Script. Delete the sample, paste this file.
 * 3. Put the Sheet ID in SHEET_ID below.
 * 4. Deploy > New deployment > type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Click Deploy, authorize, and copy the Web App URL (ends in /exec).
 * 5. Paste that URL into the dashboard Settings > "Apps Script Web App URL".
 *
 * The sheet auto-creates a "records" tab and one column per field on first write.
 */

var SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
var TAB = 'records';

// Master column order. New fields are appended automatically if they appear.
var COLS = [
  'id','type','role','date','client','rep','setter','product','callType',
  'followUpOutreach','newOutreach','callsOffered','callsSet','callCapacity','speedToLead',
  'newMeetings','connectedMeetings','followUpMeetings','advancedCalls','noShows',
  'closedDeals','contractsSigned','contractValue','cashCollected','depositCollected',
  'aosiSold','productBSold','notes','submittedAt'
];

function sheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB);
    sh.appendRow(COLS);
  }
  return sh;
}

function doGet() {
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  if (values.length > 1) {
    var head = values[0];
    for (var r = 1; r < values.length; r++) {
      var obj = {};
      for (var c = 0; c < head.length; c++) obj[head[c]] = values[r][c];
      out.push(obj);
    }
  }
  return json_(out);
}

function doPost(e) {
  var sh = sheet_();
  var rec = JSON.parse(e.postData.contents);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  // append any new columns we have not seen before
  Object.keys(rec).forEach(function (k) {
    if (head.indexOf(k) === -1) {
      sh.getRange(1, head.length + 1).setValue(k);
      head.push(k);
    }
  });
  var row = head.map(function (k) { return rec[k] != null ? rec[k] : ''; });
  sh.appendRow(row);
  return json_({ ok: true, id: rec.id });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
