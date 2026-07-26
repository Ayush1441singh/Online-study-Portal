const trainingData = [
    [1, 48, 42, 35, 5, 'At Risk'], [2, 55, 48, 45, 5, 'At Risk'],
    [1, 62, 51, 50, 6, 'At Risk'], [3, 58, 55, 48, 5, 'At Risk'],
    [2, 65, 58, 55, 6, 'At Risk'], [3, 60, 60, 52, 6, 'At Risk'],
    [3, 68, 62, 60, 6, 'Needs Improvement'], [4, 70, 64, 62, 6, 'Needs Improvement'],
    [3, 72, 66, 65, 7, 'Needs Improvement'], [4, 67, 68, 63, 6, 'Needs Improvement'],
    [5, 74, 70, 68, 7, 'Needs Improvement'], [4, 76, 69, 70, 6, 'Needs Improvement'],
    [5, 78, 72, 74, 7, 'On Track'], [6, 80, 75, 76, 7, 'On Track'],
    [5, 82, 74, 78, 7, 'On Track'], [6, 77, 79, 75, 7, 'On Track'],
    [7, 83, 78, 80, 7, 'On Track'], [6, 85, 76, 82, 7, 'On Track'],
    [7, 88, 84, 86, 8, 'High Performer'], [8, 90, 86, 88, 8, 'High Performer'],
    [7, 92, 82, 90, 8, 'High Performer'], [9, 87, 89, 85, 8, 'High Performer'],
    [8, 94, 90, 92, 8, 'High Performer'], [9, 91, 92, 89, 8, 'High Performer'],
];

const featureNames = ['studyHours', 'attendance', 'previousScore', 'assignmentScore', 'sleepHours'];
const featureRanges = [12, 100, 100, 100, 12];

function squaredDistance(first, second) {
    return first.reduce((total, value, index) => {
        const difference = (value - second[index]) / featureRanges[index];
        return total + difference * difference;
    }, 0);
}

function recommendationFor(label, input) {
    const actions = [];
    if (input.studyHours < 5) actions.push('Schedule at least 5 focused study hours each week.');
    if (input.attendance < 75) actions.push('Improve class attendance and review every missed lesson.');
    if (input.assignmentScore < 70) actions.push('Complete assignments early and ask for feedback.');
    if (input.sleepHours < 7) actions.push('Aim for 7–8 hours of sleep before study days.');
    if (!actions.length) actions.push('Maintain your routine and attempt higher-difficulty practice questions.');
    if (label === 'At Risk') actions.unshift('Meet your instructor or mentor this week to create a recovery plan.');
    return actions.slice(0, 3);
}

function predictStudentPerformance(input, neighborCount = 5) {
    const vector = featureNames.map((name) => input[name]);
    const neighbors = trainingData
        .map((row) => ({ label: row[5], distance: squaredDistance(vector, row.slice(0, 5)) }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, neighborCount);

    const votes = neighbors.reduce((counts, neighbor) => {
        counts[neighbor.label] = (counts[neighbor.label] || 0) + 1;
        return counts;
    }, {});
    const [prediction, voteCount] = Object.entries(votes).sort((first, second) => second[1] - first[1])[0];

    return {
        prediction,
        confidence: Math.round((voteCount / neighbors.length) * 100),
        algorithm: 'K-Nearest Neighbors (KNN)',
        trainingSamples: trainingData.length,
        recommendations: recommendationFor(prediction, input),
    };
}

module.exports = { featureNames, predictStudentPerformance };
