function buildSyntheticCaseExclusionSql(caseAlias = "c", messageAlias = "m") {
  return `(
    (${caseAlias}.notion_page_id IS NOT NULL AND ${caseAlias}.notion_page_id LIKE 'test-%')
    OR LOWER(COALESCE(${caseAlias}.agency_name, '')) LIKE '%e2e%'
    OR LOWER(COALESCE(${caseAlias}.subject_name, '')) LIKE '%e2e%'
    OR LOWER(COALESCE(${caseAlias}.case_name, '')) LIKE '%e2e%'
    OR LOWER(COALESCE(${caseAlias}.agency_name, '')) LIKE '%synthetic%'
    OR LOWER(COALESCE(${caseAlias}.subject_name, '')) LIKE '%synthetic%'
    OR LOWER(COALESCE(${caseAlias}.case_name, '')) LIKE '%synthetic%'
    OR LOWER(COALESCE(${caseAlias}.subject_name, '')) LIKE '%localhost qa%'
    OR LOWER(COALESCE(${caseAlias}.case_name, '')) LIKE '%localhost qa%'
    OR LOWER(COALESCE(${caseAlias}.agency_name, '')) LIKE 'scenario agency%'
    OR LOWER(COALESCE(${caseAlias}.agency_email, '')) LIKE '%shadewofficial%'
    OR LOWER(COALESCE(${caseAlias}.agency_email, '')) LIKE '%test@agency.gov%'
    OR LOWER(COALESCE(${caseAlias}.agency_email, '')) LIKE '%@matcher.com'
    OR EXISTS (
      SELECT 1
      FROM messages ${messageAlias}
      WHERE ${messageAlias}.case_id = ${caseAlias}.id
        AND (
          LOWER(COALESCE(${messageAlias}.subject, '')) LIKE '%e2e%'
          OR LOWER(COALESCE(${messageAlias}.body_text, '')) LIKE '%localhost qa%'
          OR LOWER(COALESCE(${messageAlias}.normalized_body_text, '')) LIKE '%localhost qa%'
          OR LOWER(COALESCE(${messageAlias}.to_email, '')) LIKE '%test@agency.gov%'
          OR LOWER(COALESCE(${messageAlias}.from_email, '')) LIKE '%test@agency.gov%'
          OR LOWER(COALESCE(${messageAlias}.to_email, '')) LIKE '%shadewofficial@gmail.com%'
          OR LOWER(COALESCE(${messageAlias}.from_email, '')) LIKE '%shadewofficial@gmail.com%'
          OR LOWER(COALESCE(${messageAlias}.to_email, '')) LIKE '%shadewofficial+%'
          OR LOWER(COALESCE(${messageAlias}.from_email, '')) LIKE '%shadewofficial+%'
          OR LOWER(COALESCE(${messageAlias}.to_email, '')) LIKE '%@matcher.com'
          OR LOWER(COALESCE(${messageAlias}.from_email, '')) LIKE '%@matcher.com'
        )
    )
  )`;
}

function buildRealCaseWhereClause(caseAlias = "c", messageAlias = "m") {
  return `NOT ${buildSyntheticCaseExclusionSql(caseAlias, messageAlias)}`;
}

module.exports = {
  buildSyntheticCaseExclusionSql,
  buildRealCaseWhereClause,
};
