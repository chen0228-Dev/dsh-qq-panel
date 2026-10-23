import json
import os
import urllib.request

cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
print('imageGen:', cfg.get('imageGen'))
print('asr:', cfg.get('asr'))
print('features.stt:', cfg.get('features', {}).get('stt'), 'sttModel:', cfg.get('features', {}).get('sttModel'))

html = urllib.request.urlopen('http://127.0.0.1:18080/', timeout=10).read().decode()
print('served_has_imagegen_card:', 'id="ig-enabled"' in html)
print('served_has_asr_provider:', 'id="ar-provider"' in html)
print('served_has_opinion_gate:', 'switch gate-head"><div><div class="lab">允许她表态' in html)
print('token_file:', os.path.exists('/opt/qqbot/panel/data/internal.token'))
if os.path.exists('/opt/qqbot/panel/data/internal.token'):
    print('token_mode:', oct(os.stat('/opt/qqbot/panel/data/internal.token').st_mode & 0o777))

# 未带令牌应当被拒（证明内部接口不是裸奔的）
try:
    urllib.request.urlopen(
        urllib.request.Request('http://127.0.0.1:18080/api/imagegen/generate', data=b'{"prompt":"x"}', method='POST'),
        timeout=10,
    )
    print('no_token_rejected: False  <-- 有问题')
except urllib.error.HTTPError as e:
    print('no_token_rejected:', e.code, e.read().decode()[:80])
