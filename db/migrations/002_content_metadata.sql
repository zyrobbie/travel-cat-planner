-- Remove the source's explicitly forbidden UI examples, incorrectly included by initial extraction.
DELETE FROM content_versions WHERE id='SYS-032';
-- Shared story scene metadata: season and time of day are distinct, same for each pair.
UPDATE content_versions SET payload=jsonb_set(jsonb_set(payload,'{narrativeSeason}',CASE WHEN payload->>'sceneId'='FIREFLY' THEN '"初夏"'::jsonb ELSE 'null'::jsonb END),'{timeOfDay}',CASE WHEN payload->>'sceneId'='FIREFLY' THEN '"夜晚"'::jsonb ELSE '"傍晚"'::jsonb END) WHERE type IN ('LINKED','ORDINARY');
