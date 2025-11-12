/**
 * Test normalization function
 */

const canon = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const input1 = 'Ready to Send';
const input2 = 'Ready To Send';

console.log(`Input 1: "${input1}"`);
console.log(`Canonical: "${canon(input1)}"`);
console.log(`\nInput 2: "${input2}"`);
console.log(`Canonical: "${canon(input2)}"`);
console.log(`\nMatch: ${canon(input1) === canon(input2)}`);

// Simulate the actual function
const mockPropertyInfo = {
    type: 'select',
    select: {
        options: [
            { name: 'Ready To Send' },
            { name: 'Sent' },
            { name: 'Needs Human Review' }
        ]
    }
};

function normalizeStatusValue(value, propertyInfo) {
    if (!value || !propertyInfo) {
        return value;
    }

    const target = canon(value);
    const optionsContainer = propertyInfo[propertyInfo.type];
    const options = optionsContainer?.options || [];

    console.log(`\n=== Normalize "${value}" ===`);
    console.log(`Target canonical: "${target}"`);
    console.log(`Available options:`, options.map(o => o.name));

    const directMatch = options.find(opt => opt?.name === value);
    if (directMatch) {
        console.log(`Direct match found: "${directMatch.name}"`);
        return directMatch.name;
    }

    const canonicalMatch = options.find(opt => {
        const optCanon = canon(opt?.name);
        console.log(`  Comparing "${optCanon}" === "${target}": ${optCanon === target}`);
        return optCanon === target;
    });

    if (canonicalMatch) {
        console.log(`Canonical match found: "${canonicalMatch.name}"`);
        return canonicalMatch.name;
    }

    console.log(`No match found, using original: "${value}"`);
    return value;
}

const result = normalizeStatusValue('Ready to Send', mockPropertyInfo);
console.log(`\nFinal result: "${result}"`);
