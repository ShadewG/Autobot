import type { ExemptionInfo } from './types';

/**
 * State FOIA exemption data
 * Contains common exemptions by state with known exceptions
 */
export const STATE_EXEMPTIONS: Record<string, ExemptionInfo[]> = {
  SC: [
    {
      statute: 'SC Code § 30-4-40(a)(3)',
      title: 'Law Enforcement Records',
      exceptions: [
        'After investigation closed',
        'Arrest records after booking',
        'Criminal incident reports',
        'Mugshots after charges filed'
      ]
    },
    {
      statute: 'SC Code § 23-1-240(B)',
      title: 'Body-Worn Camera',
      exceptions: [
        'Released to defendant in criminal case',
        'Released by court order',
        'Officer-involved shooting',
        'Complaint against officer',
        'Released to victim or family'
      ]
    },
    {
      statute: 'SC Code § 30-4-40(a)(4)',
      title: 'Personnel Records',
      exceptions: [
        'Name, title, salary are public',
        'Disciplinary actions after final determination'
      ]
    },
    {
      statute: 'SC Code § 30-4-40(a)(2)',
      title: 'Trade Secrets',
      exceptions: [
        'If submitted with grant application',
        'If used for government decision-making'
      ]
    }
  ],
  NC: [
    {
      statute: 'NC G.S. § 132-1.4',
      title: 'Law Enforcement Records',
      exceptions: [
        'Records become public after 5 years',
        'Arrest records after booking',
        'Incident reports (non-confidential portions)'
      ]
    },
    {
      statute: 'NC G.S. § 132-1.4A',
      title: 'Recordings',
      exceptions: [
        'Released to persons depicted or their representatives',
        'Court order',
        'Death in custody'
      ]
    },
    {
      statute: 'NC G.S. § 126-22',
      title: 'Personnel Records',
      exceptions: [
        'Name, age, hire date, salary are public',
        'Promotion/demotion/transfer/dismissal info',
        'Office to which assigned'
      ]
    }
  ],
  GA: [
    {
      statute: 'O.C.G.A. § 50-18-72(a)(4)',
      title: 'Law Enforcement Records',
      exceptions: [
        'Initial crime incident report public within 72 hours',
        'Arrest booking records public',
        'Records public after case closed'
      ]
    },
    {
      statute: 'O.C.G.A. § 50-18-72(a)(5)',
      title: 'Personnel Records',
      exceptions: [
        'Name, salary, title are public',
        'Employment applications after hire'
      ]
    }
  ],
  FL: [
    {
      statute: 'Fla. Stat. § 119.071(2)(c)',
      title: 'Active Criminal Investigation',
      exceptions: [
        'Information already publicly disclosed',
        'Completed investigation records',
        'Arrest and booking information'
      ]
    },
    {
      statute: 'Fla. Stat. § 119.071(3)(a)',
      title: 'Personnel Information',
      exceptions: [
        'Name, salary, title are public',
        'Performance evaluations (final)',
        'Disciplinary actions'
      ]
    }
  ],
  TX: [
    {
      statute: 'Tex. Gov't Code § 552.108',
      title: 'Law Enforcement Information',
      exceptions: [
        'After investigation closed',
        'Basic booking information',
        'Arrest reports after 60 days'
      ]
    },
    {
      statute: 'Tex. Gov't Code § 552.101',
      title: 'Privacy Exemption',
      exceptions: [
        'Public officials in official capacity',
        'Information already public',
        'Compelling public interest override'
      ]
    }
  ],
  VA: [
    {
      statute: 'Va. Code § 2.2-3706(A)',
      title: 'Criminal Records',
      exceptions: [
        'Incident reports (redacted)',
        'Records after case closed',
        'Statistical data'
      ]
    },
    {
      statute: 'Va. Code § 2.2-3705.1',
      title: 'Personnel Records',
      exceptions: [
        'Name, position, salary public',
        'Final disciplinary records'
      ]
    }
  ],
  OK: [
    {
      statute: '51 O.S. § 24A.8',
      title: 'Law Enforcement Records',
      exceptions: [
        'Arrest records public',
        'Incident/complaint records public',
        'Records after investigation closed'
      ]
    },
    {
      statute: '51 O.S. § 24A.7',
      title: 'Personnel Records',
      exceptions: [
        'Names, salaries, titles public',
        'Disciplinary actions public'
      ]
    }
  ],
  TN: [
    {
      statute: 'Tenn. Code § 10-7-504(a)(2)',
      title: 'Criminal Investigation',
      exceptions: [
        'Arrest records public',
        'Records after prosecution concluded',
        'Statistical data'
      ]
    },
    {
      statute: 'Tenn. Code § 10-7-504(a)(21)',
      title: 'Personnel Records',
      exceptions: [
        'Name, title, salary public',
        'Final disciplinary actions'
      ]
    }
  ],
  AL: [
    {
      statute: 'Ala. Code § 36-12-40',
      title: 'Public Records Generally',
      exceptions: [
        'Arrest records public',
        'Incident reports public',
        'Court records public'
      ]
    }
  ],
  MS: [
    {
      statute: 'Miss. Code § 25-61-12',
      title: 'Law Enforcement Records',
      exceptions: [
        'Arrest records public',
        'Incident reports (non-exempt portions)',
        'Statistical data'
      ]
    }
  ],
};

/**
 * Get exemptions for a state
 */
export function getStateExemptions(stateCode: string): ExemptionInfo[] {
  return STATE_EXEMPTIONS[stateCode.toUpperCase()] || [];
}

/**
 * Find a matching exemption by statute citation
 */
export function findExemptionByStatute(stateCode: string, statute: string): ExemptionInfo | undefined {
  const exemptions = getStateExemptions(stateCode);
  return exemptions.find(ex =>
    statute.toLowerCase().includes(ex.statute.toLowerCase()) ||
    ex.statute.toLowerCase().includes(statute.toLowerCase())
  );
}
