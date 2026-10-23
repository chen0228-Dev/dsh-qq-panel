"""确认线上页面有「上传文件夹」按钮和 webkitdirectory 输入框。"""
import urllib.request

html = urllib.request.urlopen('http://127.0.0.1:18080/', timeout=10).read().decode('utf-8')
print('has_button:', 'id="fs-updir"' in html)
print('has_webkitdirectory:', 'webkitdirectory' in html)
print('has_progress_span:', 'id="fs-progress"' in html)
print('has_upload_helper:', 'function fsUpload' in html)
print('checks_fetch_ok:', "if (!r.ok)" in html)
