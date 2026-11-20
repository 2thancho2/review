// Supabase 대시보드 > Project Settings > API 에서 복사하세요.
// anon(또는 publishable) 키는 공개돼도 되는 키예요. 대신 보안은 schema.sql의 RLS가 지켜줍니다.
// ⚠️ service_role(secret) 키와 VAPID 비공개 키는 절대 여기에 넣지 마세요.
export const SUPABASE_URL = "https://mpptlcrqvdmzrkaloasu.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_-8zkJmJuUPm375D4bJnJeQ_664e7QtX";

// 학생 아이디를 "아이디@도메인" 형태의 가짜 이메일로 바꿔 저장해요. 실제 메일은 발송되지 않아요.
// Edge Function 시크릿 STUDENT_EMAIL_DOMAIN 과 반드시 같은 값이어야 해요. (README 참고)
export const STUDENT_EMAIL_DOMAIN = "students.example.com";

// 푸시 알림용 공개 키: `node generate-vapid.mjs` 로 만든 VAPID_PUBLIC_KEY (README 참고)
export const VAPID_PUBLIC_KEY = "BPmG1LfgPoIQmC0sshwO0r8bVRhFn2qqNf19zZ2kzgt8ZY3RD3qBJq9_bnZCKC5LRX7jeH7UtXzOwmkn2iebsKw";