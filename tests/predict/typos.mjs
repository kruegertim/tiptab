// Realistic typing errors for the prediction tests (tests/predict/typos.test.mjs).
// [typed, expected autocorrection, previous word (optional)]
// Sources of the patterns: neighbouring keys on a touch keyboard, swapped letters,
// missing / doubled letters, umlauts typed as ae/oe/ue, ß as ss, common misspellings.

export const DE_TYPOS = [
    // neighbouring key
    ['Hallp', 'Hallo'], ['nivht', 'nicht'], ['jetzr', 'jetzt'], ['heure', 'heute'],
    ['morgwn', 'morgen'], ['abwr', 'aber'], ['einfsch', 'einfach'], ['wirklixh', 'wirklich'],
    ['vielleichr', 'vielleicht'], ['Freumd', 'Freund'], ['Arbeiz', 'Arbeit'], ['gesrern', 'gestern'],
    ['nachher', 'nachher'], ['Termim', 'Termin'], ['Wochenemde', 'Wochenende'], ['zusammeb', 'zusammen'],
    ['natürluch', 'natürlich'], ['bestimmr', 'bestimmt'], ['eigentluch', 'eigentlich'],
    ['Entschuldigumg', 'Entschuldigung'], ['schreibem', 'schreiben'], ['Nachrichz', 'Nachricht'],
    ['Geburtstsg', 'Geburtstag'], ['Telefom', 'Telefon'], ['kommem', 'kommen'],
    // swapped letters
    ['nicth', 'nicht'], ['dsa', 'das'], ['udn', 'und'], ['ihc', 'ich'], ['mrogen', 'morgen'],
    ['dnake', 'danke'], ['Mittwcoh', 'Mittwoch'], ['bitet', 'bitte'], ['wiel', 'weil'],
    ['abre', 'aber'], ['dei', 'die'], ['nciht', 'nicht'], ['gestren', 'gestern'], ['heuet', 'heute'],
    ['Deutschalnd', 'Deutschland'], ['Restaruant', 'Restaurant'], ['Termni', 'Termin'],
    ['vielelicht', 'vielleicht'], ['Wohnugn', 'Wohnung'], ['shcon', 'schon'], ['scheon', 'schon'],
    ['Freudn', 'Freund'], ['zusmamen', 'zusammen'], ['imemr', 'immer'], ['wiedre', 'wieder'],
    // missing letter
    ['knnst', 'kannst'], ['sclafen', 'schlafen'], ['vileicht', 'vielleicht'], ['ebenflls', 'ebenfalls'],
    ['Entschuldigun', 'Entschuldigung'], ['Gebrtstag', 'Geburtstag'], ['eigntlich', 'eigentlich'],
    ['wirklch', 'wirklich'], ['Wochende', 'Wochenende'], ['Bahnhf', 'Bahnhof'], ['Kaffe', 'Kaffee'],
    ['Telfon', 'Telefon'], ['mogen', 'morgen'], ['nacher', 'nachher'],
    // doubled / extra letter
    ['nichtt', 'nicht'], ['Hallloo', 'Hallo'], ['ddanke', 'danke'], ['heutte', 'heute'],
    ['morrgen', 'morgen'], ['abber', 'aber'], ['scchon', 'schon'],
    // umlauts and ß
    ['fur', 'für'], ['tschuss', 'tschüss'], ['fuer', 'für'], ['ueber', 'über'], ['Maedchen', 'Mädchen'],
    ['muessen', 'müssen'], ['koennen', 'können'], ['moechte', 'möchte'], ['waere', 'wäre'],
    ['schoen', 'schön'], ['groesser', 'größer'], ['Strasse', 'Straße'], ['heisst', 'heißt'],
    ['weiss', 'weiß'], ['haeufig', 'häufig'], ['Uebung', 'Übung'], ['Gruesse', 'Grüße'],
    ['spaeter', 'später'], ['natuerlich', 'natürlich'], ['moeglich', 'möglich'], ['Fruehstueck', 'Frühstück'],
    ['muss', 'muss'], ['Grusse', 'Grüße'], ['spater', 'später'], ['naturlich', 'natürlich'],
    ['wurde', 'wurde'], ['Mochte', 'Mochte'],
    // common misspellings
    ['eigendlich', 'eigentlich'], ['Standart', 'Standart'], ['nähmlich', 'nämlich'], ['wiederrum', 'wiederum'],
    ['Rhythmuss', 'Rhythmus'], ['vieleicht', 'vielleicht'], ['ziehmlich', 'ziemlich'], ['tod', 'Tod'],
    // lower-case nouns and glued phrases
    ['haus', 'Haus'], ['auto', 'Auto'], ['wochenende', 'Wochenende'], ['schule', 'schule'],
    ['garnicht', 'gar nicht'], ['vorallem', 'vor allem'], ['aufjedenfall', 'auf jeden Fall'],
    // context helps
    ['Tg', 'Tag', 'guten'], ['hsbe', 'habe', 'ich'],
];

export const EN_TYPOS = [
    // neighbouring key
    ['tge', 'the'], ['wuth', 'with'], ['thst', 'that'], ['jave', 'have'], ['frim', 'from'],
    ['bexause', 'because'], ['somethimg', 'something'], ['tomorroq', 'tomorrow'], ['peoplw', 'people'],
    ['thinl', 'think'], ['knoe', 'know'], ['woukd', 'would'], ['coild', 'could'], ['abour', 'about'],
    ['meeying', 'meeting'], ['tonighr', 'tonight'], ['morninf', 'morning'], ['probabky', 'probably'],
    // swapped letters
    ['teh', 'the'], ['adn', 'and'], ['hte', 'the'], ['wiht', 'with'], ['yuo', 'you'], ['becuase', 'because'],
    ['ahve', 'have'], ['hosue', 'house'], ['knwo', 'know'], ['waht', 'what'], ['becasue', 'because'],
    ['thsi', 'this'], ['jsut', 'just'], ['tiem', 'time'], ['soem', 'some'], ['form', 'form'],
    ['freind', 'friend'], ['beleive', 'believe'], ['thier', 'their'], ['wierd', 'weird'], ['recieve', 'receive'],
    // missing / extra letters
    ['somthing', 'something'], ['realy', 'really'], ['untill', 'until'], ['tommorow', 'tomorrow'],
    ['goverment', 'government'], ['occured', 'occurred'], ['thnk', 'think'], ['probly', 'probably'],
    ['diffrent', 'different'], ['beautifull', 'beautiful'], ['finaly', 'finally'], ['acually', 'actually'],
    ['wnat', 'want'], ['plese', 'please'], ['agian', 'again'], ['tonite', 'tonite'],
    // misspellings
    ['peopel', 'people'], ['definately', 'definitely'], ['seperate', 'separate'], ['wich', 'which'],
    ['becuz', 'becuz'], ['accomodate', 'accommodate'], ['neccessary', 'necessary'],
    // apostrophes, glued words, capitals
    ['dont', "don't"], ['im', "I'm"], ['youre', "you're"], ['cant', "can't"], ['wont', "won't"],
    ['didnt', "didn't"], ['isnt', "isn't"], ['thats', "that's"], ['whats', "what's"], ['ive', "I've"],
    ['alot', 'a lot'], ['i', 'I'], ['monday', 'Monday'], ['english', 'English'],
];

// Valid words that must never be changed (lower case unless the word is a noun).
export const DE_KEEP = [
    'ich', 'du', 'das', 'dass', 'der', 'die', 'und', 'nicht', 'aber', 'weil', 'wie', 'was', 'wo', 'kann',
    'muss', 'mussten', 'wurde', 'würde', 'schon', 'schön', 'Haus', 'Hause', 'essen', 'Essen', 'laut', 'morgen',
    'Morgen', 'weg', 'Weg', 'leben', 'Leben', 'wissen', 'recht', 'fest', 'gut', 'neue', 'Feuer', 'Mauer',
    'aktuell', 'Quelle', 'Museum', 'Bauer', 'teuer', 'Steuer', 'genauer', 'blau', 'Michael', 'Israel', 'Poesie',
    'Aerobic', 'Koexistenz', 'Masse', 'Kasse', 'Klasse', 'Tasse', 'lassen', 'wissen', 'besser',
    'Wasser', 'Schlüssel', 'Fahrradschlüssel', 'Geburtstagsparty', 'Kaffeetassen', 'Hausmeisterei',
    'tschüss', 'okay', 'ok', 'na', 'ja', 'nee', 'nö', 'hm', 'bzw', 'usw', 'ca', 'zB',
    'cool', 'Meeting', 'Update', 'Laptop', 'Feedback', 'Handy',
];

// Not in the dictionary but often meant (loan words, names, chat slang). Autocorrect may
// get a few of these wrong (iOS too); the user's undo then blocks the correction.
export const DE_UNKNOWN_KEEP = [
    'sorry', 'nice', 'Kevin', 'Jana', 'Lena', 'lol', 'omg', 'hdl', 'WhatsApp', 'Emoji', 'chillen',
];

export const EN_KEEP = [
    'the', 'and', 'their', 'there', 'they', 'were', 'where', 'its', "it's", 'well', 'ill', 'lets', 'hell',
    'shell', 'wed', 'id', 'form', 'from', 'then', 'than', 'quiet', 'quite', 'house', 'mouse', 'may', 'May',
    'will', 'mark', 'bill', 'august', 'polish', 'china', 'turkey', 'march', 'ok', 'okay', 'yeah', 'hey',
    'gonna', 'wanna', 'lol', 'btw', 'email', 'online', 'website',
];

export const EN_UNKNOWN_KEEP = ['omg', 'idk', 'tbh', 'Kevin', 'Jana', 'Ubuntu', 'GNOME', 'emoji', 'selfie'];
