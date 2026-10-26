const fs = require('node:fs');

function decodeXmlAttribute(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'"
  })[entity]);
}

function parseLevelCatalog(xml) {
  const levels = [];
  const levelPattern = /<lv\b([^>]*)>([\s\S]*?)<\/lv>/g;
  let match;

  while ((match = levelPattern.exec(xml)) !== null) {
    const attributes = {};
    const attributePattern = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
    let attribute;
    while ((attribute = attributePattern.exec(match[1])) !== null) {
      attributes[attribute[1]] = decodeXmlAttribute(attribute[2]);
    }

    if (!/^\d+$/.test(attributes.id || '') || !attributes.ln) continue;
    const description = /<uc><!\[CDATA\[([\s\S]*?)\]\]><\/uc>/.exec(match[2]);
    const rating = Number(attributes.rg);
    levels.push({
      id: Number(attributes.id),
      title: attributes.ln,
      author: attributes.un || 'Unknown',
      description: description ? description[1].trim() : '',
      rating: Number.isFinite(rating) ? rating : null
    });
  }

  return levels;
}

function readLevelCatalog(filePath) {
  return parseLevelCatalog(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { parseLevelCatalog, readLevelCatalog };
