"""确认线上页面已经带上 Edge 无情感的说明。"""
import urllib.request

html = urllib.request.urlopen('http://127.0.0.1:18080/', timeout=10).read().decode('utf-8')
print('served_note:', '这一档没有「情感」设置' in html)
print('served_toast:', '但没有情感设置' in html)
print('served_volc_emotion:', 'id="v-emotion"' in html)
