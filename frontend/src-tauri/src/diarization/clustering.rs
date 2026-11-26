//! Agglomerative hierarchical clustering (AHC) of speaker embeddings.
//!
//! Embeddings are length-normalized, so cosine distance = 1 - dot product.
//! Uses average linkage via the Lance-Williams update. The merges stop at a
//! distance threshold when the speaker count is not known, and at a cut that
//! has the chosen number of speakers when it is.
//!
//! A cluster counts as a speaker only when it holds [`MIN_SPEAKER_TURNS`]
//! turns (pyannote's `min_cluster_size`, #217). Smaller clusters join the
//! nearest speaker, so one odd turn neither spends a chosen count nor shows
//! as a speaker of its own.

/// Turns a cluster needs to count as a speaker.
///
/// A turn is one local speaker of one 10 s analysis window, and the windows
/// do not overlap (`collect_turns`), so a cluster of one turn is a voice heard
/// in a single window. Its one embedding cannot tell a person from that
/// window's laughter, noise or clipped word: there is no second sample of the
/// voice to agree with it. A cluster of two turns is the same voice found in
/// two windows. On the meeting of #207 a single 1.6 s turn was the third
/// cluster, so a chosen two merged the two real voices of 61 and 63 turns.
pub const MIN_SPEAKER_TURNS: usize = 2;

/// Cluster `embeddings` (each already length-normalized) into speaker labels.
///
/// * `num_speakers` - with `Some(k)`, exactly `k` labels (when there are `k`
///   embeddings): the coarsest cut of the merge tree with `k` clusters of
///   [`MIN_SPEAKER_TURNS`], the smaller clusters joined to the nearest of
///   them. When no cut has `k` such clusters (too few turns), the cut with
///   `k` clusters of any size, so the chosen count still holds.
/// * `threshold` - cosine-distance stop threshold when `num_speakers` is
///   None; a cluster smaller than [`MIN_SPEAKER_TURNS`] then joins the
///   nearest larger one, unless there is none.
///
/// Returns a label (0-based, contiguous, in order of each label's first
/// embedding) for each input embedding.
pub fn agglomerative(
    embeddings: &[Vec<f32>],
    num_speakers: Option<usize>,
    threshold: f32,
) -> Vec<usize> {
    let n = embeddings.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }

    let target = num_speakers.map(|k| k.clamp(1, n));
    // Average linkage never merges closer than the merge before it, so the
    // merges under the threshold are a prefix of the sequence.
    let merges = merge_sequence(embeddings, target.is_none().then_some(threshold));

    let (cut, fold_small) = match target {
        None => (merges.len(), true),
        Some(k) => match coarsest_cut_with_speakers(n, &merges, k) {
            Some(cut) => (cut, true),
            None => (n - k, false),
        },
    };

    let mut clusters = partition(n, &merges[..cut]);
    if fold_small {
        fold_small_clusters(embeddings, &mut clusters);
    }
    let mut labels = contiguous(&clusters);

    // When a speaker count is known, refine with a few centroid reassignment
    // passes (spherical k-means). AHC gives a good partition; reassignment
    // cleans boundary points that average-linkage left in the wrong cluster.
    let k = labels.iter().copied().max().map_or(0, |m| m + 1);
    if target.is_some() && k >= 2 {
        refine_centroids(embeddings, &mut labels, k, 8);
    }

    labels
}

/// The clusters under `threshold` as they are, with no cluster folded into
/// another: labels as [`agglomerative`] returns them.
///
/// For checks that ask whether every turn agrees, not how many speakers to
/// report. The mic voiceprint guard uses it: there a one-turn cluster is
/// another voice, laughter or noise on the mic, and it must block enrolment
/// rather than join the user's voice and go into the voiceprint.
pub fn agglomerative_unfolded(embeddings: &[Vec<f32>], threshold: f32) -> Vec<usize> {
    let n = embeddings.len();
    if n < 2 {
        return vec![0; n];
    }
    let merges = merge_sequence(embeddings, Some(threshold));
    contiguous(&partition(n, &merges))
}

/// One merge of the tree: cluster `absorbed` joined cluster `kept`, each
/// named by an embedding index.
#[derive(Debug, Clone, Copy)]
struct Merge {
    kept: usize,
    absorbed: usize,
}

/// The merges of average-linkage AHC in order, closest pair first, until one
/// cluster is left or, with `stop_above`, the closest pair is farther apart.
fn merge_sequence(embeddings: &[Vec<f32>], stop_above: Option<f32>) -> Vec<Merge> {
    let n = embeddings.len();
    let mut dist = vec![vec![0f32; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let d = 1.0 - dot(&embeddings[i], &embeddings[j]);
            dist[i][j] = d;
            dist[j][i] = d;
        }
    }

    let mut active: Vec<bool> = vec![true; n];
    let mut size: Vec<f32> = vec![1.0; n];
    let mut merges = Vec::with_capacity(n - 1);

    while merges.len() + 1 < n {
        // Find the closest active pair.
        let mut best = f32::INFINITY;
        let mut bi = 0usize;
        let mut bj = 0usize;
        for i in 0..n {
            if !active[i] {
                continue;
            }
            for j in (i + 1)..n {
                if !active[j] {
                    continue;
                }
                if dist[i][j] < best {
                    best = dist[i][j];
                    bi = i;
                    bj = j;
                }
            }
        }
        if stop_above.is_some_and(|threshold| best > threshold) {
            break;
        }

        // Merge bj into bi (average linkage, Lance-Williams).
        let si = size[bi];
        let sj = size[bj];
        for k in 0..n {
            if !active[k] || k == bi || k == bj {
                continue;
            }
            let new_d = (si * dist[bi][k] + sj * dist[bj][k]) / (si + sj);
            dist[bi][k] = new_d;
            dist[k][bi] = new_d;
        }
        size[bi] = si + sj;
        active[bj] = false;
        merges.push(Merge { kept: bi, absorbed: bj });
    }
    merges
}

/// The number of merges after which the tree has exactly `k` clusters of
/// [`MIN_SPEAKER_TURNS`], the most such number (the coarsest cut), or None
/// when no cut has `k`. Going down the tree, merging small clusters can make
/// a speaker and merging two speakers unmakes one, so the count rises and
/// falls; the coarsest cut leaves the fewest small clusters to fold in.
fn coarsest_cut_with_speakers(n: usize, merges: &[Merge], k: usize) -> Option<usize> {
    let large = |size: usize| usize::from(size >= MIN_SPEAKER_TURNS);
    let mut size = vec![1usize; n];
    let mut speakers = (0..n).map(|_| large(1)).sum::<usize>();
    let mut found = (speakers == k).then_some(0);
    for (done, merge) in merges.iter().enumerate() {
        let (a, b) = (size[merge.kept], size[merge.absorbed]);
        speakers = speakers - large(a) - large(b) + large(a + b);
        size[merge.kept] = a + b;
        if speakers == k {
            found = Some(done + 1);
        }
    }
    found
}

/// The cluster of each embedding after `merges`, named by the embedding index
/// that stands for it.
fn partition(n: usize, merges: &[Merge]) -> Vec<usize> {
    let mut owner: Vec<usize> = (0..n).collect();
    for merge in merges {
        for slot in owner.iter_mut() {
            if *slot == merge.absorbed {
                *slot = merge.kept;
            }
        }
    }
    owner
}

/// Joins each cluster smaller than [`MIN_SPEAKER_TURNS`] to the speaker
/// cluster whose centroid is nearest its own centroid. Nothing moves when
/// there is no speaker cluster: then no cluster has better standing than
/// another.
fn fold_small_clusters(embeddings: &[Vec<f32>], clusters: &mut [usize]) {
    let mut members: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
    for (index, &cluster) in clusters.iter().enumerate() {
        members.entry(cluster).or_default().push(index);
    }
    let centroid = |indices: &[usize]| centroid(indices.iter().map(|&i| embeddings[i].as_slice()));
    let speakers: Vec<(usize, Vec<f32>)> = members
        .iter()
        .filter(|(_, indices)| indices.len() >= MIN_SPEAKER_TURNS)
        .map(|(&cluster, indices)| (cluster, centroid(indices)))
        .collect();
    if speakers.is_empty() {
        return;
    }
    for indices in members.values().filter(|indices| indices.len() < MIN_SPEAKER_TURNS) {
        let own = centroid(indices);
        let nearest = speakers
            .iter()
            .max_by(|a, b| dot(&own, &a.1).total_cmp(&dot(&own, &b.1)))
            .map(|(cluster, _)| *cluster)
            .expect("speakers is not empty");
        for &index in indices {
            clusters[index] = nearest;
        }
    }
}

/// Labels 0.. in order of each cluster's first embedding.
fn contiguous(clusters: &[usize]) -> Vec<usize> {
    let mut seen: Vec<usize> = Vec::new();
    clusters
        .iter()
        .map(|cluster| match seen.iter().position(|c| c == cluster) {
            Some(label) => label,
            None => {
                seen.push(*cluster);
                seen.len() - 1
            }
        })
        .collect()
}

/// The mean of unit vectors, normalized again.
fn centroid<'a>(vectors: impl Iterator<Item = &'a [f32]>) -> Vec<f32> {
    let mut sum: Vec<f32> = Vec::new();
    for vector in vectors {
        if sum.is_empty() {
            sum = vec![0.0; vector.len()];
        }
        for (s, v) in sum.iter_mut().zip(vector) {
            *s += v;
        }
    }
    let norm = sum.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-8);
    sum.iter_mut().for_each(|v| *v /= norm);
    sum
}

/// Iterative nearest-centroid reassignment on unit embeddings.
fn refine_centroids(embeddings: &[Vec<f32>], labels: &mut [usize], k: usize, iters: usize) {
    let n = embeddings.len();
    if n == 0 || k == 0 {
        return;
    }
    let dim = embeddings[0].len();
    for _ in 0..iters {
        // Mean centroids, re-normalized.
        let mut cents = vec![vec![0f32; dim]; k];
        let mut counts = vec![0f32; k];
        for i in 0..n {
            let c = labels[i].min(k - 1);
            counts[c] += 1.0;
            for d in 0..dim {
                cents[c][d] += embeddings[i][d];
            }
        }
        for c in 0..k {
            if counts[c] <= 0.0 {
                continue;
            }
            for d in 0..dim {
                cents[c][d] /= counts[c];
            }
            let norm = cents[c].iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-8);
            for d in 0..dim {
                cents[c][d] /= norm;
            }
        }

        let mut changed = false;
        let mut proposed = labels.to_vec();
        for i in 0..n {
            let mut best = labels[i].min(k - 1);
            let mut best_sim = f32::NEG_INFINITY;
            for c in 0..k {
                if counts[c] <= 0.0 {
                    continue;
                }
                let sim = dot(&embeddings[i], &cents[c]);
                if sim > best_sim {
                    best_sim = sim;
                    best = c;
                }
            }
            if best != labels[i] {
                proposed[i] = best;
                changed = true;
            }
        }
        // A forced count must remain exact. Reject an iteration that would
        // empty any cluster (plain k-means can otherwise collapse k to k-1).
        let mut proposed_counts = vec![0usize; k];
        for &lab in &proposed {
            proposed_counts[lab] += 1;
        }
        if proposed_counts.iter().any(|&count| count == 0) {
            break;
        }
        labels.copy_from_slice(&proposed);
        if !changed {
            break;
        }
    }

    // Relabel to contiguous 0..k'-1 in case empty clusters dropped out.
    let mut map = vec![None; k];
    let mut next = 0usize;
    for lab in labels.iter_mut() {
        let old = *lab;
        if map[old].is_none() {
            map[old] = Some(next);
            next += 1;
        }
        *lab = map[old].unwrap();
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<f32> {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / norm).collect()
    }

    /// Two voices 0.5 apart (cosine distance), each heard in `turns` turns,
    /// and between them one turn more than 0.6 from both: the shape of #207,
    /// where the two voices are closer to each other than to the odd turn.
    fn voices_and_an_outlier(turns: usize) -> Vec<Vec<f32>> {
        let a = [1.0, 0.0, 0.0];
        let b = [0.5, 0.866, 0.0];
        let outlier = unit(&[0.2, 0.3, 0.93]);
        assert!((1.0 - dot(&unit(&a), &unit(&b)) - 0.5).abs() < 0.01);
        assert!(1.0 - dot(&unit(&a), &outlier) > 0.6 && 1.0 - dot(&unit(&b), &outlier) > 0.6);
        let jitter = |base: [f32; 3], i: usize| unit(&[base[0] + 0.01 * i as f32, base[1] - 0.01 * i as f32, base[2] + 0.005 * i as f32]);
        let mut embeddings: Vec<Vec<f32>> = (0..turns).map(|i| jitter(a, i)).collect();
        embeddings.push(outlier);
        embeddings.extend((0..turns).map(|i| jitter(b, i)));
        embeddings
    }

    #[test]
    fn forced_count_stays_exact_after_refinement() {
        let embeddings = vec![
            vec![1.0, 0.0],
            vec![0.99, 0.01],
            vec![0.0, 1.0],
            vec![0.01, 0.99],
        ];
        let labels = agglomerative(&embeddings, Some(2), 0.60);
        assert_eq!(labels.iter().copied().max().unwrap() + 1, 2);
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[2], labels[3]);
        assert_ne!(labels[0], labels[2]);
    }

    #[test]
    fn threshold_keeps_obvious_speakers_apart() {
        let embeddings = vec![vec![1.0, 0.0], vec![0.99, 0.01], vec![0.0, 1.0], vec![0.01, 0.99]];
        let labels = agglomerative(&embeddings, None, 0.20);
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[2], labels[3]);
        assert_ne!(labels[0], labels[2]);
    }

    /// #207: two chosen speakers are the two voices, not one voice and the
    /// odd turn; the odd turn joins one of them.
    #[test]
    fn a_chosen_count_is_spent_on_voices_not_on_an_outlier() {
        let labels = agglomerative(&voices_and_an_outlier(5), Some(2), 0.60);
        assert_eq!(labels.iter().copied().max().unwrap() + 1, 2);
        assert!(labels[..5].iter().all(|&l| l == labels[0]));
        assert!(labels[6..].iter().all(|&l| l == labels[6]));
        assert_ne!(labels[0], labels[6]);
        assert!(labels[5] == labels[0] || labels[5] == labels[6]);
    }

    /// Without a count, the threshold merges the two voices (0.5 < 0.6) and
    /// the odd turn is not reported as a second speaker.
    #[test]
    fn a_detected_count_does_not_report_a_one_turn_speaker() {
        let labels = agglomerative(&voices_and_an_outlier(5), None, 0.60);
        assert!(labels.iter().all(|&l| l == 0));
        // Under a tighter threshold the voices stay apart and the odd turn
        // still joins one of them.
        let labels = agglomerative(&voices_and_an_outlier(5), None, 0.45);
        assert_eq!(labels.iter().copied().max().unwrap() + 1, 2);
        assert_ne!(labels[0], labels[6]);
    }

    /// Three chosen speakers where two voices of two turns each repeat: no
    /// cut has three clusters of two turns, so the odd turn is the third
    /// speaker rather than the count falling short.
    #[test]
    fn a_chosen_count_holds_when_too_few_turns_repeat() {
        let labels = agglomerative(&voices_and_an_outlier(2), Some(3), 0.60);
        assert_eq!(labels, vec![0, 0, 1, 2, 2]);
    }

    /// Single turns all far apart: no cluster is a speaker, so none is
    /// folded into another.
    #[test]
    fn lone_turns_stay_apart_when_none_repeats() {
        let embeddings = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0], vec![0.0, 0.0, 1.0]];
        let labels = agglomerative(&embeddings, None, 0.60);
        assert_eq!(labels, vec![0, 1, 2]);
    }

    /// The unfolded variant keeps the odd turn apart where the folding one
    /// joins it to the voices.
    #[test]
    fn the_unfolded_clusters_keep_a_one_turn_cluster() {
        let embeddings = voices_and_an_outlier(5);
        assert!(agglomerative(&embeddings, None, 0.60).iter().all(|&l| l == 0));
        let labels = agglomerative_unfolded(&embeddings, 0.60);
        assert_eq!(labels.iter().copied().max().unwrap() + 1, 2);
        assert!(labels.iter().enumerate().all(|(i, &l)| (l != labels[0]) == (i == 5)));
    }
}
