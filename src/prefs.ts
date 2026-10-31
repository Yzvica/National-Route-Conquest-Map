// 都道府県と地方。コードは JIS X 0401(scripts/add_prefectures.py と同じ)
export const PREF_NAMES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

export const prefName = (code: number) => PREF_NAMES[code - 1] ?? "不明";

/** 地方と、そこに入る都道府県コードの範囲 [最初, 最後] */
export const REGIONS: { name: string; from: number; to: number }[] = [
  { name: "北海道", from: 1, to: 1 },
  { name: "東北", from: 2, to: 7 },
  { name: "関東", from: 8, to: 14 },
  { name: "中部", from: 15, to: 23 },
  { name: "近畿", from: 24, to: 30 },
  { name: "中国", from: 31, to: 35 },
  { name: "四国", from: 36, to: 39 },
  { name: "九州・沖縄", from: 40, to: 47 },
];

export const regionOf = (code: number) => REGIONS.find((r) => code >= r.from && code <= r.to)!;
