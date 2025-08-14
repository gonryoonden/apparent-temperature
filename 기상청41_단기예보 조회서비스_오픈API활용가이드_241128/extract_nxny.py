import pandas as pd
import json

xlsx_path = '격자_위경도(2411).xlsx'  # 엑셀 파일명

# 엑셀 로드(시트명은 첫 시트 기준)
df = pd.read_excel(xlsx_path)

def make_region_name(row):
    # 1단계/2단계/3단계 합침(광역시/구/동 등)
    names = [str(row[c]) for c in ['1단계', '2단계', '3단계'] if pd.notnull(row[c])]
    return ' '.join(names).strip()

data = {}
for _, row in df.iterrows():
    name = make_region_name(row)
    nx = int(row['격자 X'])
    ny = int(row['격자 Y'])
    if name:
        data[name] = {"nx": nx, "ny": ny}

with open('nxny_map.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"총 {len(data)}개 지역 변환 완료. → nxny_map.json 생성됨")
