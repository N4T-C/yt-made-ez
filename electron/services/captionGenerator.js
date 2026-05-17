const DEFAULT_CAPTIONS = [
    'Epic', 'Legendary', 'Wow', 'Insane', 'Vibes', 'Mood', 'Goals', 'Amazing',
    'Unreal', 'Smooth', 'Clean', 'Perfect', 'Classic', 'Iconic', 'Elite',
    'Pure Joy', 'Big Energy', 'So Good', 'Wild', 'Chaos', 'Legend', 'Chief',
    'Main Character', 'Final Boss', 'Bruh', 'Sheesh', 'Sigma', 'Sus', 'NPC',
    'Skill', 'Talent', 'Pro', 'God Mode', 'W', 'Absolute W', 'L', 'Ratio',
    'Caught', 'Busted', 'Smooth Operator', 'Mission Passed', 'Respect',
    'Instant Regret', 'Wait For It', 'Mind Blown', 'Hidden Gem', 'Full Speed',
    'No Way', 'Speechless', 'Gamer', 'Clutch', 'Carry', 'GG', 'EZ', 'Clean AF'
];

function generateCaptions(count = 5) {
    const source = [...DEFAULT_CAPTIONS];
    const picks = [];

    while (picks.length < count && source.length > 0) {
        const idx = Math.floor(Math.random() * source.length);
        picks.push(source.splice(idx, 1)[0]);
    }

    while (picks.length < count) {
        const fallbackWords = ['Epic', 'W', 'Insane', 'Legendary', 'Mood', 'Clean', 'Smooth', 'Unreal', 'Sheesh', 'Bruh', 'Sigma', 'Clutch', 'Carry', 'GG', 'EZ', 'Wow', 'Wild', 'Chaos', 'Goals', 'Absolute W', 'Busted', 'Caught', 'Mind Blown', 'Respect'];
        picks.push(fallbackWords[Math.floor(Math.random() * fallbackWords.length)]);
    }

    return picks;
}

function getRandomCaption() {
    const source = [...DEFAULT_CAPTIONS];
    const fallbackWords = ['Epic', 'W', 'Insane', 'Legendary', 'Mood', 'Clean', 'Smooth', 'Unreal', 'Sheesh', 'Bruh', 'Sigma', 'Clutch', 'Carry', 'GG', 'EZ', 'Wow', 'Wild', 'Chaos', 'Goals', 'Absolute W', 'Busted', 'Caught', 'Mind Blown', 'Respect'];

    if (Math.random() > 0.5) {
        return source[Math.floor(Math.random() * source.length)];
    }
    return fallbackWords[Math.floor(Math.random() * fallbackWords.length)];
}

module.exports = { generateCaptions, getRandomCaption };
