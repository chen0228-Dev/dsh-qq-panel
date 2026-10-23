"""验证 Edge 合成：正负数语速/音调都要能用。

之前 `'--rate', '-10%'` 这种分开写法会被 argparse 当成新选项，
报 usage 退出；改成 `--rate=-10%` 后才能正常解析。
面板下拉里 -20% / -10% / -6Hz 三个选项都会踩到这个坑。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]

cases = [
    ('-20%', '-6Hz', '很慢+低沉（两个负数）'),
    ('-10%', '+0Hz', '偏慢（就是报错那组）'),
    ('+0%', '-6Hz', '正常语速+低沉'),
    ('+8%', '+2Hz', '推荐值'),
    ('+30%', '+12Hz', '很快+娃娃音'),
]
fail = 0
for rate, pitch, note in cases:
    payload = {
        'text': f'语速{rate}音调{pitch}测试',
        'provider': 'edge',
        'voiceName': 'zh-CN-XiaoyiNeural',
        'rate': rate,
        'pitch': pitch,
    }
    req = urllib.request.Request(
        BASE + '/api/voice/preview',
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            n = len(r.read())
            ok = n > 2000
            print(f'[{"PASS" if ok else "FAIL"}] rate={rate} pitch={pitch} → {n} bytes  {note}')
            if not ok:
                fail += 1
    except urllib.error.HTTPError as e:
        fail += 1
        print(f'[FAIL] rate={rate} pitch={pitch} → {e.code} {e.read().decode("utf-8", "replace")[:160]}')

print(f'\n失败 {fail} 项' if fail else '\n全部通过')
