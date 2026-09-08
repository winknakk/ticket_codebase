-- ============================================================
-- AutomationX V3 Demo Seed Data
-- seed_demo.sql
-- ============================================================

-- Clean existing demo data. This seed intentionally rebuilds the configured
-- development/demo dataset and must never be used as a production baseline.
TRUNCATE TABLE
  admin_audit_logs, ai_memory, company_holidays, company_holiday_calendars,
  conversation_events, conversation_handoffs, conversation_participants,
  conversation_ticket_links, customer_enrollments, document_embeddings,
  internal_notes, knowledge_embeddings, knowledge_documents,
  message_attachments, operator_project_access, takeover_sessions, operators,
  teams, outbox_events, ticket_events, ticket_embeddings, webhook_events,
  webchat_sessions, traces, tickets, messages, conversations, identities,
  profile_projects, profiles, project_prompts, project_sla_policies,
  project_channels, project_ai_settings, project_routing_rules,
  project_business_hours, project_holidays, project_mcp_permissions,
  project_feature_flags, projects, companies
RESTART IDENTITY CASCADE;

-- 1. Companies & Projects
INSERT INTO companies (id, name) VALUES 
  (1, 'Demo Company'),
  (2, 'Retail Solutions Corp'),
  (5, 'Avalant Co.,Ltd.')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO projects (id, company_id, name, environment, project_type) VALUES 
  (1, 1, 'AutomationX Demo', 'AutomationX Demo Environment', 'Demo Project'),
  (2, 2, 'Customer Success Service', 'Customer Success Production', 'Support Project'),
  (8, 5, '24/7', 'Avalant 24/7 Production', 'Support Project'),
  (11, 5, 'SSO Project', 'SSO Production', 'Support Project'),
  (12, 5, 'CRA Project', 'CRA Production', 'Support Project')
ON CONFLICT (id) DO UPDATE SET 
  company_id = EXCLUDED.company_id, 
  name = EXCLUDED.name,
  environment = EXCLUDED.environment,
  project_type = EXCLUDED.project_type;

-- 2. Customer Profiles
INSERT INTO profiles (id, company_id, name) VALUES 
  (1, 1, 'John Doe'),
  (2, 2, 'Jane Smith'),
  (5, 5, 'Akkharin Laksana'),
  (11, 5, 'SSO Test Customer'),
  (12, 5, 'CRA Test Customer'),
  (10, 1, 'LINE Test User'),
  (67, 5, 'Natapohn Sawatsakulpattana'),
  (404, 1, 'LINE Group Demo User')
ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name;

INSERT INTO profile_projects (profile_id, project_id) VALUES 
  (1, 1),
  (2, 2),
  (5, 8),
  (11, 11),
  (12, 12),
  (10, 1),
  (67, 8),
  (404, 1)
ON CONFLICT (profile_id, project_id) DO NOTHING;

-- 3. Identities (LINE and WhatsApp references)
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES 
  ('1', 1, 'line', 'U123456'),
  ('2', 2, 'whatsapp', 'W987654'),
  ('7', 5, 'line', 'Uad28c1eabbcbe1608e038d4d162f4944'),
  ('11', 11, 'line', 'U4be68575767f6b4a56e7d079f4c6d442'),
  ('12', 12, 'line', 'U60cacc31b2bb8a8ea8fb1779265edbc9'),
  ('13', 10, 'line', 'U6256f0c4dbb64edacf9eea92904e49b1'),
  ('67', 67, 'line', 'Ue3575daf4967d84d3a634bf55a06881c'),
  ('404', 404, 'line_group', 'C22fcb231cbd31e218daf68bf86c644c3')
ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, channel = EXCLUDED.channel, channel_ref = EXCLUDED.channel_ref;

-- 4. Conversations (various states)
INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by, assigned_pm) VALUES 
  (1, '1', 1, 'line', 'open', 'ai', NULL),
  (2, '2', 2, 'whatsapp', 'open', 'human', 'agent_alice'),
  (3, '1', 1, 'line', 'closed', 'ai', NULL),
  (5, '7', 8, 'line', 'open', 'ai', NULL),
  (11, '11', 11, 'line', 'open', 'ai', NULL),
  (12, '12', 12, 'line', 'open', 'ai', NULL),
  (67, '67', 8, 'line', 'open', 'ai', NULL),
  (404, '404', 1, 'line_group', 'open', 'ai', NULL)
ON CONFLICT (id) DO UPDATE SET identity_id = EXCLUDED.identity_id, project_id = EXCLUDED.project_id, channel = EXCLUDED.channel, status = EXCLUDED.status, handled_by = EXCLUDED.handled_by;

-- 5. Message History
INSERT INTO messages (conversation_id, role, content, created_at) VALUES
  (1, 'customer', 'Cannot login Orbit App session expired', '2026-07-15 10:46:35.230905+07'),
  (1, 'ai', 'Please clear cache and restart your application.', '2026-07-15 10:46:35.230905+07'),
  (2, 'customer', 'I need billing support for invoice #1004', '2026-07-15 10:46:35.230905+07'),
  (2, 'ai', 'Billing support requires manual review. Redirecting...', '2026-07-15 10:46:35.230905+07'),
  (2, 'human', 'Hi Jane, this is Alice from billing. How can I help?', '2026-07-15 10:46:35.230905+07'),
  (3, 'customer', 'Hi there, how does the system work?', '2026-07-15 10:46:35.230905+07'),
  (3, 'ai', 'Our system automatically tracks issues and resolves tickets.', '2026-07-15 10:46:35.230905+07'),
  (5, 'customer', 'ระบบล่ม ขึ้น Error 404 Server เข้าไม่ได้เลย รีบด่วน', '2026-07-15 10:46:35.230905+07'),
  (11, 'customer', 'ขอความช่วยเหลือ เข้าใช้งานระบบ SSO ไม่ได้ครับ', '2026-07-15 10:46:35.230905+07'),
  (12, 'customer', 'สอบถามเรื่องสิทธิ์ใช้งานระบบ CRA หน่อยครับ', '2026-07-15 10:46:35.230905+07'),
  -- Production messages (conversation 67)
  (67, 'customer', 'ระบบล่มขึ้น 502 Bad Gateway เข้าไม่ได้เลย ด่วน', '2026-07-17 15:40:19.320804+07'),
  (67, 'ai', 'ระบบล่มขึ้น 502 Bad Gateway เข้าใช้งานไม่ได้เลยนะคะ ⚡ เปิดตั๋วงานให้ทีมดูแลด่วนเลย หมายเลขติดตามเรื่องคือ TCK-2026-35448 ทีมจะเร่งแก้ไขโดยเร็วที่สุดค่ะ ถ้ามีอะไรเพิ่มเติมหรือต้องการแจ้งเพิ่มเติมบอกได้เลยนะคะ!', '2026-07-17 15:40:44.461768+07'),
  (67, 'customer', 'ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย ด่วน', '2026-07-17 15:44:15.605974+07'),
  (67, 'customer', 'ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย ด่วน', '2026-07-17 15:47:36.145809+07'),
  (67, 'ai', $$อ๋อ ขึ้น 405 Method Not Allowed แบบนี้... ยังไม่มีข้อมูลในระบบนะคะ เดี๋ยวขอเปิดตั๋วงานให้เลยนะคะ เพื่อให้ทีมเทคนิครีบตรวจสอบและแก้ไขโดยเร็วค่ะ 🛠️ระบบได้รับแจ้งปัญหาเรื่อง 'ระบบล่ม 405 Method Not Allowed' เรียบร้อยแล้วค่ะ 📋 หมายเลขติดตามเรื่องของคุณคือ TCK-2026-83685 ทีมจะเร่งดำเนินการแก้ไขให้เสร็จภายในวันที่ 17 กรกฎาคม 2569 ค่ะ ถ้ามีความคืบหน้าหรือปัญหาอื่นๆ แจ้งนิวได้เลยนะคะ 💪$$, '2026-07-17 15:48:13.625932+07'),
  (67, 'customer', 'เรื่องที่แจ้งไปถึงไหนแล้ว', '2026-07-17 15:49:25.804725+07'),
  (67, 'ai', 'ตอนนี้เรื่องที่แจ้งไว้ทั้งหมดยังอยู่ในสถานะ Backlog นะคะ ซึ่งหมายความว่าทางทีมงานยังอยู่ในขั้นตอนการเตรียมแก้ไข โดยเป็นเรื่องด่วนระดับ P1 อยู่ค่ะ ถ้ามีความคืบหน้าหรือทีมงานเริ่มดำเนินการแล้ว นิวจะแจ้งให้ทราบทันทีนะคะ 😊 จะช่วยอะไรเพิ่มเติมอีกไหมคะ?', '2026-07-17 15:50:05.03297+07'),
  (67, 'customer', 'เรื่องที่แจ้งไปถึงไหนแล้ว', '2026-07-17 15:50:31.576831+07'),
  (67, 'ai', 'ตอนนี้เรื่องที่แจ้งไว้เกี่ยวกับระบบล่มที่ขึ้น error 405 Method Not Allowed และ 502 Bad Gateway ทั้งหมดอยู่ในสถานะ Backlog ค่ะ ทีมงานยังอยู่ในคิวรอเริ่มดำเนินการแก้ไขอย่างเร่งด่วนระดับ P1 อยู่เลยค่ะ ⚡ ถ้ามีอะไรเพิ่มเติมหรือต้องการให้ช่วยติดตามย้ำ ให้บอกนิวได้เลยนะคะ 😊', '2026-07-17 15:51:08.429028+07'),
  (67, 'customer', 'อยากทราบว่าตอนนี้เรื่องระบบล่ม error 405 Method Not Allowed มีความคืบหน้าไปถึงไหนแล้ว', '2026-07-17 15:51:52.734888+07'),
  (67, 'ai', 'ขออธิบายก่อนนะคะ ตอนนี้ทีมงานได้รับเรื่องระบบล่ม error 405 Method Not Allowed ที่แจ้งไว้แล้วค่ะ ทางเราได้รวมเรื่องจากที่แจ้งซ้ำกันไว้เป็นเรื่องเดียวกันเรียบร้อยแล้วนะคะ สถานะตอนนี้ยังอยู่ในคิวรอดำเนินการ (Backlog) ซึ่งเป็นความสำคัญสูงสุดระดับ P1 ทีมงานกำลังเตรียมจัดการอย่างเร่งด่วนที่สุดค่ะ ถ้ามีอัปเดตเพิ่มเติมจะรีบแจ้งให้ทราบทันทีนะคะ 😊', '2026-07-17 15:52:27.138172+07'),
  (67, 'customer', 'อยากทราบว่าตอนนี้เรื่องระบบล่ม error 405 Method Not Allowed มีความคืบหน้าไปถึงไหนแล้ว', '2026-07-17 16:04:11.883205+07'),
  (67, 'ai', 'ขออัปเดตสถานะเรื่องระบบล่ม error 405 Method Not Allowed ให้นะคะ ตอนนี้มี 2 เรื่องที่รายงานเข้ามาเหมือนกันทั้งคู่ ยังคงอยู่ในสถานะรอดำเนินการ (Backlog) ค่ะ ทีมงานยังไม่ได้เริ่มแก้ไขโดยตรงแต่ทราบเรื่องแล้วและกำลังจัดลำดับความสำคัญให้ค่ะ ช่วงนี้ถ้ามีข้อมูลเพิ่มเติมหรือมีอะไรที่อยากให้ช่วยเร่ง แจ้งได้เลยนะคะ 😊', '2026-07-17 16:04:48.551013+07'),
  (67, 'customer', 'อยากทราบว่าตอนนี้เรื่องระบบล่ม error 405 Method Not Allowed มีความคืบหน้าไปถึงไหนแล้ว', '2026-07-17 16:05:22.381421+07'),
  (67, 'ai', 'เข้าใจเลยค่ะ ระบบล่ม error 405 Method Not Allowed ที่แจ้งนี้ ทีมงานกำลังดำเนินการแก้ไขอยู่ค่ะ ⚡ เรื่องนี้เป็นด่วนระดับ P1 ทีมจะรีบจัดการให้เร็วที่สุดนะคะ ถ้าต้องการให้ช่วยอะไรเพิ่มเติมแจ้งได้เลยนะคะ 😊', '2026-07-17 16:05:51.760912+07'),
  (67, 'customer', 'ปิดเรื่องระบบล่ม error 405 Method Not Allowed ให้หน่อย', '2026-07-17 16:06:14.024475+07'),
  (67, 'ai', 'ปิดเรื่องระบบล่ม error 405 Method Not Allowed ให้เรียบร้อยแล้วนะคะ 😊 หากมีปัญหาอื่นเพิ่มเติม แจ้งนิวได้เลยนะคะ!', '2026-07-17 16:06:40.679184+07'),
  (67, 'customer', 'ปิดเรื่องระบบล่ม error 405 Method Not Allowed ให้หน่อย', '2026-07-17 16:20:02.248533+07'),
  (67, 'ai', 'เรื่องระบบล่ม error 405 Method Not Allowed นิวปิดเรื่องให้เรียบร้อยทั้ง 2 ใบแล้วนะคะ 😊 ถ้ามีอะไรเพิ่มเติมหรือต้องการช่วยเหลืออีก สะดวกทักมาได้เลยค่ะ!', '2026-07-17 16:20:35.581979+07'),
  (67, 'customer', 'ปิดเรื่อง 502 Bad Gateway ให้หน่อย', '2026-07-17 16:48:17.22449+07'),
  (67, 'ai', 'ขอบคุณที่แจ้งมานะคะ 😊 ตอนนี้เรื่อง "502 Bad Gateway" ที่แจ้งไว้ ได้ปิดเรียบร้อยแล้วค่ะ ถ้ามีอะไรให้ช่วยเหลือเพิ่มเติม บอกนิวได้เลยนะคะ!', '2026-07-17 16:48:47.072498+07'),
  (67, 'customer', 'ระบบล่มขึ้น 408 Request Timeout เข้าไม่ได้เลย ด่วน', '2026-07-20 09:55:00.790086+07'),
  (67, 'ai', 'ระบบล่มและขึ้นข้อผิดพลาด 408 Request Timeout แบบนี้ เข้าใจเลยค่ะว่าเป็นเรื่องด่วนมาก นิวได้เปิดตั๋วงานให้ทีมดูแลโดยด่วนเลยนะคะ 📋 หมายเลขติดตามเรื่องของคุณคือ TCK-2026-69378 ทีมจะรีบแก้ไขภายใน 4 ชั่วโมงนี้ ถ้ามีอะไรเพิ่มเติมหรือต้องการอัปเดต แจ้งนิวได้เลยนะคะ 💪', '2026-07-20 09:55:22.695548+07'),
  (67, 'customer', 'ตอนนี้ผมอยู่ใน Project อะไร???', '2026-07-20 11:22:41.669767+07'),
  (67, 'ai', 'ตอนนี้นิวขออนุญาตเช็กข้อมูลเพิ่มเติมนิดนึงนะคะ เพราะระบบยังไม่เจอรายละเอียดโปรเจกต์ที่คุณกำลังพูดถึง เพื่อให้ช่วยได้ตรงจุดมากขึ้น รบกวนแจ้งชื่อโปรเจกต์หรือรายละเอียดเพิ่มเติมได้ไหมคะ?', '2026-07-20 11:23:01.049509+07'),
  (67, 'customer', 'หวัดดีงับ', '2026-07-20 14:53:45.943273+07'),
  (67, 'customer', 'หวัดดีงับคนสวย', '2026-07-20 14:54:55.231183+07'),
  (67, 'ai', 'หวัดดีค่า 😊 ยินดีต้อนรับนะคะ มีอะไรให้ช่วยหรือต้องการสอบถามไหมคะ?', '2026-07-20 14:55:05.561189+07'),
  (67, 'customer', 'ขอทราบรายละเอียดเกี่ยวกับโปรเจคของผมหน่อย', '2026-07-20 14:55:40.014383+07'),
  (67, 'ai', 'อ่าค่ะ ขออภัยนะคะ ตอนนี้นิวไม่สามารถดึงข้อมูลรายละเอียดโปรเจคของคุณได้ตรงนี้ แป๊บนึงนะคะ เดี๋ยวนิวจะขอเช็กเพิ่มเติมหรือตรวจสอบกับทีมที่เกี่ยวข้อง แล้วจะแจ้งกลับอย่างรวดเร็วที่สุดค่ะ ถ้ามีคำถามเพิ่มเติมระหว่างนี้ แจ้งมาได้เลยนะคะ 😊', '2026-07-20 14:55:55.821375+07'),
  (67, 'customer', 'ขอทราบรายละเอียดเกี่ยวกับโปรเจคของผมหน่อยยยยยยยยย', '2026-07-20 14:57:05.478888+07'),
  (67, 'ai', 'อ่าค่ะ ตอนนี้นิวเช็กในฐานข้อมูลแล้ว ยังไม่พบข้อมูลรายละเอียดโปรเจคของคุณเลยนะคะ 😊 ช่วยบอกเพิ่มนิดหน่อยได้ไหมคะว่าอยากทราบเรื่องไหนเป็นพิเศษ หรือมีหัวข้ออะไรที่สนใจเกี่ยวกับโปรเจคของคุณบ้างคะ?', '2026-07-20 14:57:25.137603+07'),
  (67, 'customer', 'ผมอยากรู้ว่าเรื่องที่แจ้งไปถึงไหนแล้ว', '2026-07-20 15:06:33.681581+07'),
  (67, 'ai', 'เข้าใจเลยค่ะ ตอนนี้เรื่องที่แจ้งไว้เกี่ยวกับระบบล่ม 408 Request Timeout อยู่ในสถานะ "รอดำเนินการ" (Todo) และเป็นเรื่องด่วนระดับ P1 ทีมกำลังเตรียมเริ่มแก้ไขโดยเร็วที่สุดนะคะ ⚡ ถ้าอยากรู้ข้อมูลเพิ่มเติมหรือมีอะไรที่ต้องช่วยเพิ่มเติม แจ้งได้เลยนะคะ 😊', '2026-07-20 15:07:03.671784+07'),
  (67, 'customer', 'ขอทราบรายละเอียดเกี่ยวกับโปรเจคของผมหน่อยยยยยยยยย', '2026-07-20 15:10:09.012718+07'),
  (67, 'ai', 'อ่าค่ะ ตอนนี้นิวยังไม่มีข้อมูลรายละเอียดโปรเจคของคุณในระบบนะคะ ถ้ามีคำถามเฉพาะเจาะจงเกี่ยวกับโปรเจค หรืออยากให้ช่วยเช็กเรื่องอะไรเพิ่มเติม แจ้งได้เลยนะคะ 😊', '2026-07-20 15:10:29.684738+07'),
  (67, 'customer', 'โทษทางวินัยของข้าราชการพลเรือนสามัญมีกี่สถาน และประกอบด้วยอะไรบ้าง?', '2026-07-20 15:17:08.709799+07'),
  (67, 'ai', 'อ่าค่ะ เรื่องโทษทางวินัยของข้าราชการพลเรือนสามัญ... ตอนนี้ข้อมูลในระบบไม่มีรายละเอียดชัดเจนเกี่ยวกับจำนวนสถานโทษและองค์ประกอบของโทษทางวินัยนี้เลยนะคะ นิวขอแป๊บนึงเปิดตั๋วแจ้งทีมที่ดูแลเฉพาะทางเพื่อให้คำตอบที่ถูกต้องและครบถ้วนที่สุดนะคะ', '2026-07-20 15:17:31.783833+07'),
  (67, 'customer', 'โทษทางวินัยของข้าราชการพลเรือนสามัญมีกี่สถาน และประกอบด้วยอะไรบ้าง?', '2026-07-20 15:17:59.51203+07'),
  (67, 'ai', 'โทษทางวินัยของข้าราชการพลเรือนสามัญมีทั้งหมด 5 สถาน ดังนี้ค่ะ 1. ภาคทัณฑ์ 2. ตัดเงินเดือน 3. ลดเงินเดือน 4. ปลดออก 5. ไล่ออก โดยการลงโทษต้องเป็นคำสั่งที่เหมาะสมกับความผิด และต้องเป็นไปด้วยความยุติธรรม ปราศจากอคติ พร้อมระบุชัดเจนว่าผู้ถูกลงโทษกระทำผิดในกรณีใดและตามมาตราใด', '2026-07-20 15:18:21.125086+07'),
  (67, 'customer', 'หมวดภาษีที่ดินและสิ่งปลูกสร้าง (พ.ร.บ. ภาษีที่ดินและสิ่งปลูกสร้าง พ.ศ. 2562)', '2026-07-20 15:20:03.117299+07'),
  (67, 'ai', 'อ๋อ เรื่องภาษีที่ดินและสิ่งปลูกสร้างตาม พ.ร.บ. ภาษีที่ดินและสิ่งปลูกสร้าง พ.ศ. 2562 นั้น ตอนนี้นิวยังไม่มีข้อมูลเฉพาะเจาะจงในระบบค่ะ ถ้ามีคำถามหรือรายละเอียดเพิ่มเติมเกี่ยวกับเรื่องนี้ที่อยากให้ช่วยเช็กเพิ่มเติม หรือให้เปิดเรื่องแจ้งทีมงานช่วยหาคำตอบเพิ่มเติมให้ ลองบอกนิวได้นะคะ 😊', '2026-07-20 15:20:31.584342+07'),
  (67, 'human', 'โหลงับเตง', '2026-07-20 17:03:05.132387+07'),
  -- Production messages (conversation 404 - LINE Group)
  (404, 'human', 'ฮัลโหลๆ', '2026-07-20 11:11:22.445069+07'),
  (404, 'customer', '@แอดมิน คุณคือใคร', '2026-07-20 10:16:16.455355+07'),
  (404, 'customer', '@แอดมิน คุณคือใคร', '2026-07-20 10:16:23.579341+07'),
  (404, 'ai', 'สวัสดีค่ะ 😊 นิวค่ะ ที่ปรึกษาประสบการณ์ลูกค้าและผู้เชี่ยวชาญด้านเทคนิค พร้อมช่วยเหลือคุณตลอด 24 ชั่วโมงนะคะ มีอะไรให้ช่วยบอกได้เลยนะคะ?', '2026-07-20 10:16:27.696846+07'),
  (404, 'ai', 'สวัสดีค่ะ ยินดีที่ได้รู้จักนะคะ 😊 นิว คือที่ปรึกษาประสบการณ์ลูกค้าและผู้เชี่ยวชาญด้านเทคนิคของที่นี่ค่ะ พร้อมช่วยตอบคำถาม แก้ไขปัญหา และดูแลคุณตลอด 24 ชั่วโมงเลยค่ะ มีอะไรอยากสอบถามหรือให้ช่วยได้บอกได้นะคะ?', '2026-07-20 10:16:36.257873+07'),
  (404, 'customer', '@แอดมิน คุณคือใคร', '2026-07-20 10:17:35.835824+07'),
  (404, 'ai', 'อ๋อ... นิวเป็นที่ปรึกษาประสบการณ์ลูกค้าและผู้เชี่ยวชาญด้านเทคนิคค่ะ ทำหน้าที่ช่วยตอบคำถาม แก้ปัญหา และดูแลการใช้งานระบบให้ลูกค้าแบบครบวงจรตลอด 24 ชั่วโมงนะคะ มีอะไรให้ช่วยบอกได้เลยนะคะ 😊', '2026-07-20 10:17:55.640987+07'),
  (404, 'customer', '@แอดมิน หวัดดีครับ', '2026-07-20 10:43:37.390697+07'),
  (404, 'ai', 'สวัสดีค่ะ ยินดีต้อนรับนะคะ 😊 มีอะไรให้ช่วยหรือสอบถามเรื่องไหนได้เลยนะคะ?', '2026-07-20 10:43:47.409396+07'),
  (404, 'customer', '@แอดมิน ระบบล่มขึ้น 408 Request Timeout เข้าไม่ได้เลย ด่วน', '2026-07-20 10:45:12.81567+07'),
  (404, 'customer', '@แอดมิน ระบบล่มขึ้น 404 เข้าไม่ได้เลย ด่วน', '2026-07-20 10:48:46.753131+07'),
  (404, 'ai', 'รับทราบปัญหาระบบล่มขึ้น error 404 เข้าไม่ได้เลยนะคะ ⚡ ตอนนี้นิวเปิดตั๋วงานให้ทีมดูแลด่วนแล้ว หมายเลขติดตามเรื่องของคุณคือ TCK-2026-79760 ค่ะ ทีมจะเร่งแก้ไขให้เสร็จภายในวันที่ 20 กรกฎาคม 2026 นี้ ถ้ามีอะไรเพิ่มเติมหรือต้องการอัปเดต แจ้งนิวได้เลยนะคะ 😊', '2026-07-20 10:49:08.12566+07'),
  (404, 'customer', '@แอดมิน เรื่องที่แจ้งไปถึงไหนแล้ว', '2026-07-20 10:52:18.489175+07'),
  (404, 'ai', 'เช็กสถานะเรื่องที่แจ้งมาว่า "ระบบล่มขึ้น 404 เข้าไม่ได้" พบว่าอยู่ในสถานะ Backlog ค่ะ ซึ่งหมายถึงทีมงานยังไม่ได้เริ่มดำเนินการแก้ไขนะคะ แต่เรื่องนี้เป็นด่วนระดับ P1 ทีมจะเร่งดำเนินการให้เร็วที่สุดเลยค่ะ ถ้ามีอัปเดตเพิ่มเติมจะบอกให้ทันทีนะคะ 😊', '2026-07-20 10:52:47.234905+07'),
  (404, 'customer', '@แอดมิน ปิดเรื่อง ระบบล่มขึ้น 404 เข้าไม่ได้ ให้หน่อย', '2026-07-20 10:55:13.899442+07'),
  (404, 'ai', 'เรื่อง "ระบบล่มขึ้น 404 เข้าไม่ได้" ปิดให้เรียบร้อยแล้วนะคะ 😊 ถ้ามีอะไรที่ต้องการช่วยเหลือเพิ่มเติม แจ้งได้เลยนะคะ!', '2026-07-20 10:55:39.500959+07'),
  (404, 'customer', 'ขอทราบรายละเอียดเกี่ยวกับโปรเจคของผมหน่อยยยยยยยยย', '2026-07-20 14:58:35.111129+07'),
  (404, 'ai', 'อ๋อ...ตอนนี้นิวยังไม่มีข้อมูลรายละเอียดโปรเจคของคุณในระบบเลยค่ะ 😊 อยากให้ช่วยอะไรเฉพาะเจาะจงกว่านี้ไหมคะ หรือมีคำถามเกี่ยวกับโปรเจคอะไรเพิ่มเติมบอกได้นะคะ?', '2026-07-20 14:58:53.619751+07'),
  (404, 'customer', '@แอดมิน หมวดภาษีที่ดินและสิ่งปลูกสร้าง (พ.ร.บ. ภาษีที่ดินและสิ่งปลูกสร้าง พ.ศ. 2562)', '2026-07-20 15:21:17.597471+07'),
  (404, 'ai', 'พ.ร.บ. ภาษีที่ดินและสิ่งปลูกสร้าง พ.ศ. 2562 มีรายละเอียดหลักๆ: ใช้ฐานภาษีที่ดินหรือสิ่งปลูกสร้างตามมาตรา 35 หักด้วยมูลค่ายกเว้น คูณด้วยอัตราภาษีตามมาตรา 94 กรณีที่ดินหลายแปลงติดกันให้รวมมูลค่าเป็นฐานภาษีเดียว บุคคลธรรมดาที่ใช้ที่ดินในการประกอบเกษตรกรรมหรือที่อยู่อาศัยได้รับการยกเว้นหรือลดหย่อนภาษีตามมาตรา 96-97 ถ้าต้องการทราบรายละเอียดเฉพาะมาตราใด แจ้งได้นะคะ 😊', '2026-07-20 15:21:45.572744+07')
ON CONFLICT DO NOTHING;

-- 6. Support Tickets
INSERT INTO tickets (ticket_id, conversation_id, project_id, subject, summary, status, priority, created_via) VALUES 
  ('TCK-2026-00001', 1, 1, 'Orbit App Session Expired', 'Customer reported login loop on Orbit App.', 'Open', 'P2', 'ai'),
  ('TCK-2026-00002', 2, 2, 'Billing Invoice Issue', 'Customer requested refund or review of invoice #1004.', 'Open', 'P1', 'ai'),
  ('TCK-2026-00003', 3, 1, 'General System Inquiry', 'Customer asked about system operational flows.', 'Resolved', 'P4', 'ai'),
  ('TCK-2026-35448', 67, 8, 'ระบบล่ม 502 Bad Gateway', 'ระบบล่มขึ้น 502 Bad Gateway เข้าใช้งานไม่ได้เลย ต้องการเร่งแก้ไขด่วน', 'closed', 'P1', 'ai'),
  ('TCK-2026-83685', 67, 8, 'ระบบล่ม 405 Method Not Allowed', 'ลูกค้าแจ้งว่าเข้าใช้งานระบบไม่ได้ ขึ้นข้อความ error 405 Method Not Allowed ต้องการแก้ไขด่วน', 'closed', 'P1', 'ai'),
  ('TCK-2026-90715', 67, 8, 'ระบบล่มขึ้น 405 Method Not Allowed', 'ลูกค้ารายงานว่าระบบล่มไม่สามารถเข้าใช้งานได้ ขึ้นข้อความ error 405 Method Not Allowed ต้องการให้แก้ไขด่วน', 'closed', 'P1', 'ai'),
  ('TCK-2026-69378', 67, 8, 'ระบบล่ม 408 Request Timeout', 'ลูกค้าแจ้งว่าไม่สามารถเข้าใช้งานระบบได้ เนื่องจากเกิดข้อผิดพลาด 408 Request Timeout ซึ่งส่งผลกระทบต่อการใช้งานอย่างรุนแรง ต้องการแก้ไขด่วน', 'Todo', 'P1', 'ai'),
  ('TCK-2026-79760', 404, 1, 'ระบบล่มขึ้น 404 เข้าไม่ได้', 'ลูกค้าแจ้งว่าระบบล่มขึ้น error 404 ไม่สามารถเข้าใช้งานได้ ต้องการความช่วยเหลือด่วน', 'closed', 'P1', 'ai')
ON CONFLICT DO NOTHING;

-- 7. Configuration Tables
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens) VALUES 
  (1, 'You are an helpful AI Assistant designed to resolve tickets and support customers.', 'gemini-1.5-pro', 0.00, 2048),
  (2, 'You are a sales support specialist. Direct billing requests to PMs.', 'gemini-1.5-flash', 0.50, 1024),
  (8, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ 24/7 ของ Avalant', 'gemini-1.5-pro', 0.00, 2048),
  (11, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ SSO/AD ของ กสม. (SSO Project)', 'gemini-1.5-pro', 0.00, 2048),
  (12, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT/CRA (CRA Project)', 'gemini-1.5-pro', 0.00, 2048)
ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, priority_name, description, response_hours, resolve_hours, service_window, is_default, display_order) VALUES
  -- Project 1 (Demo)
  (1, 'Urgent', 'Urgent', 'ระบบไม่สามารถใช้งานได้ เช่น 404 หรือหน้าเว็บไม่สามารถเปิดได้', 0.25, 4, '24x7', false, 1),
  (1, 'High', 'High', 'เข้าใช้งานระบบได้ แต่ไม่สามารถทำงานต่อได้ เช่น กดปุ่มไม่ได้', 0.5, 8, '24x7', false, 2),
  (1, 'Medium', 'Medium', 'ปัญหาทั่วไปที่ยังสามารถใช้งานต่อได้ เช่น คำนวณผิด แสดงผลผิด', 2, 48, 'Business Hours', true, 3),
  (1, 'Low', 'Low', 'ปัญหาเล็กน้อยที่ไม่กระทบหลัก เช่น จัดรูปแบบ Word/PDF', 24, 120, 'Business Hours', false, 4),
  (1, 'None', 'None', 'คำขอเพิ่มเติม (Feature Request) ไม่ใช่ปัญหาของระบบ', 48, 999, 'Business Hours', false, 5),
  
  -- Project 2
  (2, 'Urgent', 'Urgent', 'ระบบไม่สามารถใช้งานได้ เช่น 404 หรือหน้าเว็บไม่สามารถเปิดได้', 0.25, 4, '24x7', false, 1),
  (2, 'High', 'High', 'เข้าใช้งานระบบได้ แต่ไม่สามารถทำงานต่อได้ เช่น กดปุ่มไม่ได้', 0.5, 8, '24x7', false, 2),
  (2, 'Medium', 'Medium', 'ปัญหาทั่วไปที่ยังสามารถใช้งานต่อได้ เช่น คำนวณผิด แสดงผลผิด', 2, 48, 'Business Hours', true, 3),
  (2, 'Low', 'Low', 'ปัญหาเล็กน้อยที่ไม่กระทบหลัก เช่น จัดรูปแบบ Word/PDF', 24, 120, 'Business Hours', false, 4),
  (2, 'None', 'None', 'คำขอเพิ่มเติม (Feature Request) ไม่ใช่ปัญหาของระบบ', 48, 999, 'Business Hours', false, 5),
  
  -- Project 8
  (8, 'Urgent', 'Urgent', 'ระบบไม่สามารถใช้งานได้ เช่น 404 หรือหน้าเว็บไม่สามารถเปิดได้', 0.25, 4, '24x7', false, 1),
  (8, 'High', 'High', 'เข้าใช้งานระบบได้ แต่ไม่สามารถทำงานต่อได้ เช่น กดปุ่มไม่ได้', 0.5, 8, '24x7', false, 2),
  (8, 'Medium', 'Medium', 'ปัญหาทั่วไปที่ยังสามารถใช้งานต่อได้ เช่น คำนวณผิด แสดงผลผิด', 2, 48, 'Business Hours', true, 3),
  (8, 'Low', 'Low', 'ปัญหาเล็กน้อยที่ไม่กระทบหลัก เช่น จัดรูปแบบ Word/PDF', 24, 120, 'Business Hours', false, 4),
  (8, 'None', 'None', 'คำขอเพิ่มเติม (Feature Request) ไม่ใช่ปัญหาของระบบ', 48, 999, 'Business Hours', false, 5)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold) VALUES 
  (1, 0.70, 5, 0.60),
  (2, 0.85, 3, 0.70),
  (8, 0.70, 5, 0.60),
  (11, 0.70, 5, 0.60),
  (12, 0.70, 5, 0.60)
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true),
  (2, 'enable_auto_escalation', false),
  (2, 'enable_rag_search', false),
  (8, 'enable_auto_escalation', true),
  (8, 'enable_rag_search', true),
  (11, 'enable_auto_escalation', true),
  (11, 'enable_rag_search', true),
  (12, 'enable_auto_escalation', true),
  (12, 'enable_rag_search', true)
ON CONFLICT (project_id, flag_name) DO NOTHING;

INSERT INTO project_channels (project_id, channel_type, channel_id, secret_token, active) VALUES 
  (1, 'LINE', 'channel-123', 'secret-token-abc', true),
  (2, 'whatsapp', 'channel-456', 'secret-token-def', true),
  (11, 'LINE', 'channel-sso', 'secret-token-sso', true),
  (12, 'LINE', 'channel-cra', 'secret-token-cra', true)
ON CONFLICT DO NOTHING;

INSERT INTO project_routing_rules (project_id, rule_type, conditions, target_handler) VALUES 
  (1, 'intent', '{"contains": "billing"}', 'billing_handler'),
  (2, 'escalation', '{"sentiment": "negative"}', 'escalation_handler')
ON CONFLICT DO NOTHING;

INSERT INTO project_mcp_permissions (project_id, tool_name, allowed_roles, policy_rules) VALUES
  -- Project 1 (Demo)
  (1, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (1, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (1, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'merge_ticket', ARRAY['agent'], '{}'),
  (1, 'close_ticket', ARRAY['agent'], '{}'),
  (1, 'assign_ticket', ARRAY['agent'], '{}'),
  (1, 'update_summary', ARRAY['agent'], '{}'),
  (1, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 2
  (2, 'create_ticket', ARRAY['agent'], '{}'),
  (2, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (2, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (2, 'close_ticket', ARRAY['agent'], '{}'),
  (2, 'assign_ticket', ARRAY['agent'], '{}'),
  (2, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 8 (Avalant 24/7)
  (8, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (8, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (8, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (8, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (8, 'merge_ticket', ARRAY['agent'], '{}'),
  (8, 'close_ticket', ARRAY['agent'], '{}'),
  (8, 'assign_ticket', ARRAY['agent'], '{}'),
  (8, 'update_summary', ARRAY['agent'], '{}'),
  (8, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 11 (SSO)
  (11, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (11, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (11, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (11, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (11, 'close_ticket', ARRAY['agent'], '{}'),
  (11, 'assign_ticket', ARRAY['agent'], '{}'),
  (11, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 12 (CRA)
  (12, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (12, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (12, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (12, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (12, 'close_ticket', ARRAY['agent'], '{}'),
  (12, 'assign_ticket', ARRAY['agent'], '{}'),
  (12, 'escalate_to_pm', ARRAY['agent'], '{}')
ON CONFLICT (project_id, tool_name) DO NOTHING;

-- 8. Outbox Events
INSERT INTO outbox_events (event_type, payload, status, attempts, error_message, created_at) VALUES
  ('TicketCreated', '{"ticketId": "TCK-2026-35448"}', 'failed', 5, 'Custom Id cannot be integers', '2026-07-17 15:40:36.636734+07'),
  ('TicketCreated', '{"ticketId": "TCK-2026-90715"}', 'failed', 5, 'Custom Id cannot be integers', '2026-07-17 15:47:31.151386+07'),
  ('TicketCreated', '{"ticketId": "TCK-2026-83685"}', 'failed', 5, 'Custom Id cannot be integers', '2026-07-17 15:48:06.258886+07'),
  ('TicketCreated', '{"ticketId": "TCK-2026-69378"}', 'failed', 5, 'Custom Id cannot be integers', '2026-07-20 09:55:15.733508+07'),
  ('TicketCreated', '{"ticketId": "TCK-2026-79760"}', 'failed', 5, 'Custom Id cannot be integers', '2026-07-20 10:49:00.810233+07')
ON CONFLICT DO NOTHING;

-- 9. Operators, Teams, and Project Access
INSERT INTO teams (id, company_id, name, description, status) VALUES
  (1, 1, 'Demo Support', 'Demo support and escalation team', 'active'),
  (2, 2, 'Customer Success', 'Retail customer-success team', 'active'),
  (5, 5, 'Avalant Support', 'Avalant 24/7 support team', 'active')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO operators (id, company_id, primary_team_id, email, name, display_name, role, status) VALUES
  (1, 1, 1, 'demo.manager@ticketx.local', 'Demo Manager', 'Demo Manager', 'manager', 'active'),
  (2, 2, 2, 'alice.agent@retail.example', 'Alice Agent', 'Alice', 'agent', 'active'),
  (5, 5, 5, 'avalant.agent@ticketx.local', 'Avalant Agent', 'Avalant Support', 'agent', 'active')
ON CONFLICT (id) DO UPDATE SET
  company_id = EXCLUDED.company_id,
  primary_team_id = EXCLUDED.primary_team_id,
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  status = EXCLUDED.status;

UPDATE projects SET team_id = 1 WHERE id = 1;
UPDATE projects SET team_id = 2 WHERE id = 2;
UPDATE projects SET team_id = 5 WHERE id IN (8, 11, 12);

INSERT INTO operator_project_access (operator_id, project_id, role, granted_by) VALUES
  (1, 1, 'manager', 1),
  (2, 2, 'agent', 2),
  (5, 8, 'agent', 5),
  (5, 11, 'agent', 5),
  (5, 12, 'agent', 5)
ON CONFLICT (operator_id, project_id) DO NOTHING;

-- 10. Current Domain Relationships
INSERT INTO conversation_participants
  (conversation_id, project_id, participant_type, identity_id, session_role, join_source, joined_at)
SELECT c.id, c.project_id, 'customer', c.identity_id, 'reporter', 'direct', c.created_at
FROM conversations c
WHERE c.identity_id IS NOT NULL
ON CONFLICT (conversation_id, identity_id) DO NOTHING;

INSERT INTO customer_enrollments
  (profile_id, project_id, company_id, enrollment_source, enrollment_type, enrolled_at, is_active)
SELECT pp.profile_id, pp.project_id, p.company_id, 'imported', 'customer', NOW(), TRUE
FROM profile_projects pp
JOIN projects p ON p.id = pp.project_id
ON CONFLICT (profile_id, project_id) DO NOTHING;

INSERT INTO conversation_ticket_links (conversation_id, ticket_id, link_type, linked_by)
SELECT t.conversation_id,
       t.id,
       CASE
         WHEN t.ticket_id IN (
           'TCK-2026-00001', 'TCK-2026-00002', 'TCK-2026-00003',
           'TCK-2026-69378', 'TCK-2026-79760'
         ) THEN 'primary'
         ELSE 'related'
       END,
       'system'
FROM tickets t
WHERE t.conversation_id IS NOT NULL
ON CONFLICT (conversation_id, ticket_id) DO NOTHING;

INSERT INTO conversation_handoffs
  (conversation_id, project_id, from_owner, to_owner, to_operator_id, trigger_type, reason, started_at, context_snapshot, ticket_id)
SELECT 2, 2, 'ai', 'human', 2, 'operator_claim',
       'Billing request requires manual review', '2026-07-15 10:47:00+07',
       '{"scenario":"billing_handoff"}'::jsonb, t.id
FROM tickets t WHERE t.ticket_id = 'TCK-2026-00002';

INSERT INTO takeover_sessions
  (conversation_id, operator_id, project_id, status, acquired_at, expires_at, notes, ticket_id)
SELECT 2, 2, 2, 'active', '2026-07-15 10:47:00+07', '2027-07-15 18:47:00+07',
       'Demo active billing takeover', t.id
FROM tickets t WHERE t.ticket_id = 'TCK-2026-00002';

UPDATE conversations SET operator_id = 2, takeover_state = 'active' WHERE id = 2;

INSERT INTO internal_notes (conversation_id, ticket_id, operator_id, content, is_pinned)
SELECT 2, t.id, 2, 'Verify invoice #1004 before approving any refund.', TRUE
FROM tickets t WHERE t.ticket_id = 'TCK-2026-00002';

-- 11. Knowledge, Memory, Webhook, and Audit Scenarios
INSERT INTO company_holiday_calendars (id, company_id, name, country_code, is_default) VALUES
  (1, 1, 'Thailand Public Holidays', 'TH', TRUE)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_default = EXCLUDED.is_default;

INSERT INTO company_holidays (calendar_id, holiday_date, name, holiday_type) VALUES
  (1, '2026-12-05', 'National Day Demo Holiday', 'public')
ON CONFLICT (calendar_id, holiday_date) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO knowledge_documents
  (id, project_id, company_id, external_doc_id, title, raw_content, processed_content,
   document_type, language, chunk_index, chunk_total, is_active, indexed_at, metadata, created_by)
VALUES
  ('11111111-1111-7111-8111-111111111111', 1, 1, 'demo-orbit-session-reset',
   'Orbit App session reset guide',
   'Clear the application cache, restart the Orbit App, and sign in again. Escalate if the session loop persists.',
   'Clear cache, restart Orbit App, then sign in again.', 'procedure', 'en', 0, 1, TRUE, NOW(),
   '{"scenario":"login_support","source":"seed_demo"}'::jsonb, 1)
ON CONFLICT (project_id, external_doc_id, chunk_index) DO UPDATE SET
  title = EXCLUDED.title,
  raw_content = EXCLUDED.raw_content,
  processed_content = EXCLUDED.processed_content,
  is_active = EXCLUDED.is_active,
  indexed_at = EXCLUDED.indexed_at;

INSERT INTO ai_memory
  (profile_id, project_id, memory_type, memory_scope, key, value, source_conv_id, confidence)
VALUES
  (1, 1, 'preference', 'customer', 'preferred_support_language', 'English', 1, 0.95)
ON CONFLICT DO NOTHING;

INSERT INTO webhook_events
  (id, project_id, platform, channel_type, channel_id, platform_event_id,
   idempotency_key, raw_payload, hmac_valid, status, attempts, processed_at, resulting_conv_id, received_at)
VALUES
  ('22222222-2222-7222-8222-222222222222', 1, 'line', 'line', 'channel-123', 'demo-event-001',
   'seed-demo-line-event-001', '{"type":"message","scenario":"demo"}'::jsonb,
   TRUE, 'processed', 1, '2026-07-15 10:46:36+07', 1, '2026-07-15 10:46:35+07')
ON CONFLICT (idempotency_key) DO UPDATE SET status = EXCLUDED.status, processed_at = EXCLUDED.processed_at;

INSERT INTO conversation_events (conversation_id, event_type, payload, correlation_id, created_at) VALUES
  (2, 'HumanTakeoverStarted', '{"operatorId":2}'::jsonb, 'seed-demo-handoff-001', '2026-07-15 10:47:00+07');

INSERT INTO ticket_events (ticket_id, event_type, actor, source, correlation_id, payload, created_at)
SELECT t.id, 'TicketCreated', 'ai', 'seed_demo', 'seed-demo-ticket-00002',
       '{"priority":"P1","scenario":"billing"}'::jsonb, '2026-07-15 10:46:36+07'
FROM tickets t WHERE t.ticket_id = 'TCK-2026-00002';

INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor, operator_id, timestamp) VALUES
  (1, 'demo_seed_loaded', '{}'::jsonb, '{"seed":"seed_demo.sql"}'::jsonb, 'database_seed', 1, NOW());

-- Keep serial sequences ahead of deterministic identifiers used above.
DO $$
DECLARE
  target_table TEXT;
  sequence_name TEXT;
  max_id BIGINT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'companies','projects','profiles','identities','conversations',
    'teams','operators','company_holiday_calendars'
  ]
  LOOP
    sequence_name := pg_get_serial_sequence(target_table, 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(id), 1) FROM %I', target_table) INTO max_id;
      PERFORM setval(sequence_name, max_id, TRUE);
    END IF;
  END LOOP;
END $$;
