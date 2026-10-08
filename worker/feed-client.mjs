import { startFeedScroll } from './feed-scroll.mjs';
import { startReactions } from './reactions.mjs';

// Pass dependencies explicitly; this script is served separately from the Worker.
export const feedScript=`(${startFeedScroll.toString()})(window,document,function(win,doc){
  (${startReactions.toString()})(win,doc);
  doc.dispatchEvent(new win.Event('turnfeed:feed-appended'));
});`;
