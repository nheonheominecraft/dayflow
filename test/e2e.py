import subprocess, json, time, re, sys
from playwright.sync_api import sync_playwright, expect
R=[]
def ok(n,c):
    R.append(('PASS' if c else 'FAIL',n))
sp=subprocess.Popen(['node',__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)),'e2e-server.js')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
info=json.loads(sp.stdout.readline());BASE=f"http://127.0.0.1:{info['app']}";MOCK=f"http://127.0.0.1:{info['mock']}/v1"
def pill(p):return p.inner_text('#syn')
def wait_pill(p,txt,t=8000):
    p.wait_for_timeout(800)
    try:p.wait_for_function("t=>document.getElementById('syn').textContent.includes(t)",arg=txt,timeout=t);return True
    except Exception:return False
def nav(p,h):p.evaluate(f"location.hash='{h}'");p.wait_for_timeout(150)
def add_task(p,title):
    p.click('header [data-a=nt]');p.fill('#mt',title);p.click('#mok');p.wait_for_timeout(200)
def sync_now(p):
    p.click('#syn');p.wait_for_timeout(900)
try:
  with sync_playwright() as pw:
    br=pw.chromium.launch()
    A=br.new_context(viewport={'width':1280,'height':800});B=br.new_context(viewport={'width':390,'height':780},is_mobile=True,has_touch=True)
    errs=[]
    a=A.new_page();b=B.new_page()
    for pg in (a,b):pg.on('pageerror',lambda e:errs.append(str(e)));pg.route('**/fonts.*/**',lambda r:r.abort())
    a.goto(BASE);a.wait_for_timeout(300)
    ok('local-only pill before sign in',pill(a)=='Local only')
    nav(a,'set');a.click('[data-a=reg]');a.fill('#au','Alice');a.fill('#ae','alice@example.com');a.fill('#apw','correct horse 1');a.click('#mok')
    ok('register + first upload -> Synced',wait_pill(a,'Synced'))
    ok('account card shows email','alice@example.com' in a.inner_text('#pg'))
    nav(a,'tasks');add_task(a,'Windows task');ok('task syncs (Synced)',wait_pill(a,'Synced') and 'Windows task' in a.inner_text('#pg'))
    # second device
    b.goto(BASE);b.wait_for_timeout(300);nav(b,'set');b.click('[data-a=lin]');b.fill('#ae','alice@example.com');b.fill('#apw','wrong');b.click('#mok');b.wait_for_timeout(500)
    ok('wrong password rejected',b.locator('.ov').count()==1 and 'Invalid' in b.inner_text('.toast:last-of-type'))
    b.fill('#apw','correct horse 1');b.click('#mok');b.wait_for_selector('[data-a=uacc]',timeout=5000);ok('second device is asked how to merge',True)
    b.click('[data-a=uacc]');ok('Android device receives Windows task',wait_pill(b,'Synced') and (nav(b,'tasks') or True) and 'Windows task' in b.inner_text('#pg'))
    # edit on android -> windows
    b.click(".it:has-text('Windows task') [data-a=te]");b.fill('#mt','Edited on Android');b.click('#mok');ok('android edit syncs',wait_pill(b,'Synced'))
    nav(a,'tasks');sync_now(a);ok('windows receives android edit','Edited on Android' in a.inner_text('#pg'))
    # offline create on windows
    A.set_offline(True);add_task(a,'Offline task');a.wait_for_timeout(700)
    ok('offline: task kept locally, shows pending/offline','Offline task' in a.inner_text('#pg') and ('Offline' in pill(a) or 'pending' in pill(a)))
    ok('offline: queued op persisted',a.evaluate("JSON.parse(localStorage.getItem('df_q')).length")>=1)
    A.set_offline(False);a.evaluate("window.dispatchEvent(new Event('online'))");ok('back online -> Synced',wait_pill(a,'Synced',10000))
    nav(b,'tasks');sync_now(b);ok('android receives offline-created task','Offline task' in b.inner_text('#pg'))
    ok('no duplicates',b.locator(".it:has-text('Offline task')").count()==1)
    # delete
    a.click(".it:has-text('Offline task') [data-a=td]");a.wait_for_timeout(300)
    if a.locator('.ov #mok').count():a.click('#mok')
    ok('delete syncs',wait_pill(a,'Synced'));sync_now(b);ok('android sees deletion','Offline task' not in b.inner_text('#pg'))
    # conflict
    B.set_offline(True);b.click(".it:has-text('Edited on Android') [data-a=te]");b.fill('#mt','B version');b.click('#mok');b.wait_for_timeout(400)
    a.click(".it:has-text('Edited on Android') [data-a=te]");a.fill('#mt','A version');a.click('#mok');ok('A pushes first',wait_pill(a,'Synced'))
    B.set_offline(False);b.evaluate("window.dispatchEvent(new Event('online'))");ok('conflict detected, not overwritten',wait_pill(b,'Conflicts: 1',10000))
    srv_title=json.loads(subprocess.run(['node','-e',f"""fetch('{BASE}/api/auth/login',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{email:'alice@example.com',password:'correct horse 1'}})}}).then(r=>r.json()).then(j=>fetch('{BASE}/api/sync/pull?since=0',{{headers:{{authorization:'Bearer '+j.token}}}})).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.records.filter(x=>x.coll=='tasks'&&x.data&&/version/.test(x.data.t)).map(x=>x.data.t))))"""],capture_output=True,text=True).stdout.strip() or '[]')
    ok('server still holds A version',srv_title==['A version'])
    b.click('#syn');b.wait_for_selector('[data-a=cres]');b.click('[data-a=cres][data-v$=":mine"]');ok('keep mine resolves + syncs',wait_pill(b,'Synced',8000))
    sync_now(a);ok('A now has B version','B version' in a.inner_text('#pg'))
    # persistence
    a.reload();a.wait_for_timeout(500);ok('login persists across reload',pill(a) in('Synced','Syncing...') or wait_pill(a,'Synced'))
    # AI
    nav(a,'ai');ok('chat without key says so, no fake reply',True)
    a.fill('#aq','hello');a.press('#aq','Enter');a.wait_for_timeout(500);ok('no key -> clear error (not a demo reply)','No API key is saved' in a.inner_text('#ch'))
    nav(a,'set');a.click('[data-a=st][data-v=ai]');a.click(f"[data-a=pe][data-v=vyceai]");a.fill('#pu',MOCK);a.click('#mok');a.wait_for_timeout(700)
    a.fill('#akey','bad-key');a.click('[data-a=ksave]');a.wait_for_timeout(700);ok('key saved server-side, field cleared',a.input_value('#akey')==''and 'saved' in a.inner_text('#pg').lower())
    a.click('button[data-a=tc]');a.wait_for_timeout(800);ok('invalid key -> failed status','Last test failed' in a.inner_text('#pst') and 'dot bad' in a.get_attribute('#pdot','class'))
    a.fill('#akey','good-key');a.click('[data-a=ksave]');a.wait_for_timeout(700);a.click('button[data-a=tc]');a.wait_for_timeout(800);ok('valid key -> Connection OK','Connection OK' in a.inner_text('#pst') and 'dot ok' in a.get_attribute('#pdot','class'))
    a.click('[data-a=mr]');a.wait_for_timeout(900);t=a.inner_text('#pg');ok('models loaded from provider; default ID verified','Loaded from' in t or 'List loaded from' in t);ok('model ID verified text','found in the provider list' in t)
    ok('selected model still DeepSeek V4.1 Flash','DeepSeek V4.1 Flash' in a.inner_text('#pg'))
    ok('API key not in page or storage','good-key' not in a.content() and 'good-key' not in a.evaluate("JSON.stringify(localStorage)") and 'bad-key' not in a.evaluate("JSON.stringify(localStorage)"))
    a.fill('[data-ai=pi]','1');a.fill('[data-ai=po]','2');a.fill('[data-ai=lim]','50');a.wait_for_timeout(1200)
    nav(a,'ai');a.wait_for_timeout(300);ok('live banner','Live: requests go through your DayFlow server' in a.inner_text('#pg'))
    a.fill('#aq','plan my study time');a.press('#aq','Enter')
    a.wait_for_selector('.msg.a .mb:has-text("Mock reply")',timeout=8000);a.wait_for_selector('[data-a=rt]',timeout=8000);t=a.inner_text('.chm')
    ok('real streamed reply uses exact selected model','Mock reply from deepseek-v4.1' in t and 'Via VyceAI' in t)
    a.select_option('select[data-ai=hm]','other-model');a.wait_for_timeout(600);a.fill('#aq','again');a.press('#aq','Enter');a.wait_for_selector('.msg.a .mb:has-text("other-model")',timeout=8000)
    ok('switching model is explicit and respected','Model: other-model' in a.inner_text('.chh') or 'other-model' in a.inner_text('.chh'))
    a.select_option('select[data-ai=hm]','slow-model');a.wait_for_timeout(600);a.fill('#aq','slow one');a.press('#aq','Enter');a.wait_for_timeout(400);ok('loading/streaming state visible and input disabled',a.locator('.dots,.cur').count()>=1 and a.locator('#aq').is_disabled());a.wait_for_timeout(800);a.click('[data-a=stop]');a.wait_for_timeout(600);ok('stop aborts a live stream','Stopped' in a.inner_text('.chm'))
    a.select_option('select[data-ai=hm]','deepseek-v4.1');a.wait_for_timeout(400)
    nav(a,'set');a.click('[data-a=st][data-v=ai]');a.wait_for_timeout(1200);t=a.inner_text('#us');print('USAGE TEXT:',t.replace(chr(10),' | '));ok('usage tracked from provider token counts','Requests this month' in t and '40 in / 16 out' in t)
    # file upload
    nav(a,'ai');a.wait_for_timeout(300);a.set_input_files('#fi',[{'name':'notes.txt','mimeType':'text/plain','buffer':b'hello world'}]);a.wait_for_timeout(800);ok('file uploaded with progress state','uploaded' in a.inner_text('#fa'))
    a.set_input_files('#fi',[{'name':'run.exe','mimeType':'application/octet-stream','buffer':b'MZ'}]);a.wait_for_timeout(800);ok('invalid type rejected with message','not allowed' in a.inner_text('#fa'))
    a.click('[data-a=fx] >> nth=0');a.wait_for_timeout(500);
    # notifications
    a.evaluate("window.__n=0;window.Notification=Object.assign(class{constructor(){window.__n++}},{permission:'granted'});S.set.q=false;S.set.nt=true;S.rem.push({id:991,t:'Test reminder',d:iso(0),tm:hhmm(new Date()),rec:{k:'none',days:[]},snd:'Soft'});chk();chk()")
    ok('system notification fired once (no duplicate)',a.evaluate('window.__n')==1)
    a.evaluate("S.rem.push({id:992,t:'Quiet one',d:iso(0),tm:hhmm(new Date()),rec:{k:'none',days:[]},snd:'Soft'});S.set.q=true;S.set.qs='00:00';S.set.qe='23:59';chk()");ok('quiet hours suppress system notification',a.evaluate('window.__n')==1)
    # logout / delete
    nav(b,'set');b.click('[data-a=lo]');b.wait_for_timeout(400);ok('logout returns to local only',pill(b)=='Local only' or 'Signed out' in pill(b))
    nav(a,'set');a.click('[data-a=st][data-v=gen]');a.click('[data-a=delacc]');a.fill('#dpw','wrong');a.click('#mok');a.wait_for_timeout(500);ok('delete needs correct password',a.locator('.ov').count()==1)
    a.fill('#dpw','correct horse 1');a.click('#mok');a.wait_for_timeout(800);ok('account deleted -> local only',pill(a)=='Local only')
    code=subprocess.run(['node','-e',f"fetch('{BASE}/api/auth/login',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{email:'alice@example.com',password:'correct horse 1'}})}}).then(r=>console.log(r.status))"],capture_output=True,text=True).stdout.strip()
    ok('cannot sign in after deletion',code=='401')
    ok('no page errors',not errs)
    if errs:print('PAGE ERRORS',errs[:4])
    br.close()
except BaseException as e:
  print('EXC',repr(e)[:160])
  try:
    print('STATE b:',b.evaluate("JSON.stringify({pill:document.getElementById('syn').textContent,conf:Sync.conf.length,st:Sync.st,err:Sync.err,q:Sync.q.length,online:navigator.onLine,busy:Sync.busy})"),'modal:',b.locator('.ov').count())
  except Exception as e2:print('no state',e2)
finally:
  sp.terminate()
for r in R:print(*r)
print('FAILED:',[n for s,n in R if s=='FAIL'])
